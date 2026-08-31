//! Client-side CSRF gate for the deep-link login flow, plus a local auth audit
//! trail.
//!
//! The `rebase://callback?token=…` deep link is always delivered to the desktop
//! **app** process — even for a login the CLI started, since the CLI registers
//! no deep-link handler. A hostile page can fire that URL at any time, so before
//! opening the browser we drop a short-lived, on-disk record of the login we
//! actually started. The callback handler consumes it exactly once; a callback
//! with no matching record (or an expired one) is rejected. The record lives on
//! disk rather than in memory because it must be shared across the app and CLI
//! processes.
//!
//! We also append a small JSONL audit trail of login lifecycle events —
//! including rejected callbacks, which are the interesting CSRF signal. It never
//! records token material, only a timestamp, the event, and an optional reason.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config::config_path;

/// How long a pending-login record stays valid after `write`.
const TTL_SECS: u64 = 300;
/// Rotate the audit log once it grows past this many bytes…
const AUDIT_MAX_BYTES: u64 = 256 * 1024;
/// …keeping at most this many of the most recent lines.
const AUDIT_MAX_LINES: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingLogin {
    pub state: String,
    /// Unix seconds when the login was initiated.
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    /// Unix seconds.
    pub ts: u64,
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The `…/rebase/` config directory, reusing `config_path()`'s dir logic.
fn rebase_dir() -> Result<PathBuf> {
    let path = config_path()?;
    let dir = path
        .parent()
        .ok_or_else(|| anyhow!("config path has no parent directory"))?;
    Ok(dir.to_path_buf())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Record that a login was started with the given `state`, and audit it.
pub fn write(state: &str) -> Result<()> {
    write_in(&rebase_dir()?, state)
}

/// Read and delete the pending-login record. Returns `None` if there is no
/// record or it is older than the TTL (an expired record is treated the same as
/// a missing one). The file is deleted whenever it exists, so a single callback
/// always consumes at most one pending login.
pub fn take() -> Option<PendingLogin> {
    take_in(&rebase_dir().ok()?)
}

/// Append one audit entry. Best-effort: an audit write must never fail a login.
pub fn audit(event: &str, reason: Option<&str>) {
    if let Ok(dir) = rebase_dir() {
        let _ = audit_in(&dir, event, reason);
    }
}

/// Return up to `limit` of the most recent audit entries, oldest first.
pub fn read_log(limit: usize) -> Vec<AuditEntry> {
    match rebase_dir() {
        Ok(dir) => read_log_in(&dir, limit),
        Err(_) => Vec::new(),
    }
}

// --- dir-parameterized implementations (so tests can point at a tempdir) ---

fn pending_path(dir: &Path) -> PathBuf {
    dir.join("pending-login.json")
}

fn audit_file(dir: &Path) -> PathBuf {
    dir.join("auth-audit.log")
}

fn write_in(dir: &Path, state: &str) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let record = PendingLogin {
        state: state.to_string(),
        created_at: now_secs(),
    };
    let text = serde_json::to_string(&record).context("serializing pending login")?;
    let path = pending_path(dir);
    std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
    let _ = audit_in(dir, "login-initiated", None);
    Ok(())
}

fn take_in(dir: &Path) -> Option<PendingLogin> {
    let path = pending_path(dir);
    let text = std::fs::read_to_string(&path).ok()?;
    // Consume the record unconditionally: a callback (valid or not) ends this
    // login attempt, and leaving a stale file around would let a later callback
    // reuse it.
    let _ = std::fs::remove_file(&path);
    let record: PendingLogin = serde_json::from_str(&text).ok()?;
    if now_secs().saturating_sub(record.created_at) > TTL_SECS {
        return None;
    }
    Some(record)
}

fn audit_in(dir: &Path, event: &str, reason: Option<&str>) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let path = audit_file(dir);
    rotate_if_needed(&path)?;
    let entry = AuditEntry {
        ts: now_secs(),
        event: event.to_string(),
        reason: reason.map(|r| r.to_string()),
    };
    let line = serde_json::to_string(&entry).context("serializing audit entry")?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    writeln!(f, "{line}").with_context(|| format!("appending to {}", path.display()))?;
    Ok(())
}

/// Keep the audit log bounded: once it exceeds the byte cap, drop the oldest
/// lines and keep the most recent half (bounded by `AUDIT_MAX_LINES`).
fn rotate_if_needed(path: &Path) -> Result<()> {
    let len = match std::fs::metadata(path) {
        Ok(m) => m.len(),
        Err(_) => return Ok(()), // nothing to rotate yet
    };
    if len <= AUDIT_MAX_BYTES {
        return Ok(());
    }
    let text = std::fs::read_to_string(path)?;
    let lines: Vec<&str> = text.lines().collect();
    let keep_from = lines.len().saturating_sub(AUDIT_MAX_LINES / 2);
    let mut kept = String::new();
    for line in &lines[keep_from..] {
        kept.push_str(line);
        kept.push('\n');
    }
    std::fs::write(path, kept)?;
    Ok(())
}

fn read_log_in(dir: &Path, limit: usize) -> Vec<AuditEntry> {
    let path = audit_file(dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let mut entries: Vec<AuditEntry> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    if entries.len() > limit {
        entries = entries.split_off(entries.len() - limit);
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A unique tempdir, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "rebase-pending-test-{}-{}-{}",
                std::process::id(),
                now_secs(),
                n
            ));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn write_take_round_trip() {
        let t = TempDir::new();
        write_in(t.path(), "state-abc").unwrap();
        let record = take_in(t.path()).expect("record present");
        assert_eq!(record.state, "state-abc");
        // The file is gone after take.
        assert!(!pending_path(t.path()).exists());
    }

    #[test]
    fn take_deletes_file_and_second_take_is_none() {
        let t = TempDir::new();
        write_in(t.path(), "s").unwrap();
        assert!(take_in(t.path()).is_some());
        assert!(take_in(t.path()).is_none());
    }

    #[test]
    fn take_none_past_ttl() {
        let t = TempDir::new();
        // Hand-write an expired record.
        std::fs::create_dir_all(t.path()).unwrap();
        let expired = PendingLogin {
            state: "old".into(),
            created_at: now_secs().saturating_sub(TTL_SECS + 60),
        };
        std::fs::write(
            pending_path(t.path()),
            serde_json::to_string(&expired).unwrap(),
        )
        .unwrap();
        assert!(take_in(t.path()).is_none(), "expired record must be rejected");
        // …and consumed even though it was expired.
        assert!(!pending_path(t.path()).exists());
    }

    #[test]
    fn take_none_when_missing() {
        let t = TempDir::new();
        assert!(take_in(t.path()).is_none());
    }

    #[test]
    fn audit_appends_and_read_log_returns_entries() {
        let t = TempDir::new();
        audit_in(t.path(), "login-initiated", None).unwrap();
        audit_in(t.path(), "login-rejected", Some("no-pending")).unwrap();
        audit_in(t.path(), "login-completed", None).unwrap();
        let entries = read_log_in(t.path(), 10);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].event, "login-initiated");
        assert_eq!(entries[1].event, "login-rejected");
        assert_eq!(entries[1].reason.as_deref(), Some("no-pending"));
        assert_eq!(entries[2].event, "login-completed");
    }

    #[test]
    fn write_also_audits_initiated() {
        let t = TempDir::new();
        write_in(t.path(), "s").unwrap();
        let entries = read_log_in(t.path(), 10);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].event, "login-initiated");
    }

    #[test]
    fn read_log_limit_returns_most_recent() {
        let t = TempDir::new();
        for i in 0..5 {
            audit_in(t.path(), &format!("event-{i}"), None).unwrap();
        }
        let entries = read_log_in(t.path(), 2);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].event, "event-3");
        assert_eq!(entries[1].event, "event-4");
    }

    #[test]
    fn audit_stays_under_cap() {
        let t = TempDir::new();
        let path = audit_file(t.path());
        // Prime the file just over the byte cap so the next append rotates.
        std::fs::create_dir_all(t.path()).unwrap();
        let mut seed = String::new();
        let filler = serde_json::to_string(&AuditEntry {
            ts: 1,
            event: "seed".into(),
            reason: Some("x".repeat(64)),
        })
        .unwrap();
        while (seed.len() as u64) <= AUDIT_MAX_BYTES {
            seed.push_str(&filler);
            seed.push('\n');
        }
        std::fs::write(&path, &seed).unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > AUDIT_MAX_BYTES);

        audit_in(t.path(), "login-completed", None).unwrap();

        let len = std::fs::metadata(&path).unwrap().len();
        assert!(len <= AUDIT_MAX_BYTES, "audit log must be bounded, was {len}");
        // The freshest entry survives the rotation.
        let entries = read_log_in(t.path(), usize::MAX);
        assert_eq!(entries.last().unwrap().event, "login-completed");
    }
}
