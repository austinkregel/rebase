//! Small on-disk cache for Crucible's context layer (project grounding, rolling
//! memory, model metadata).
//!
//! Values are opaque JSON strings — Rust never knows their shapes, so adding a
//! cached thing on the TS side needs no change here. Entries expire lazily, on
//! read: nothing sweeps in the background, and a stale file simply loses to the
//! next `cache_get`.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// `{value, createdAt, expiresAt}` — the same envelope shape the VSCode
/// extension used, so cached payloads are inspectable by hand.
#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    value: String,
    created_at: u64,
    /// Absent means "never expires" — grounding relies on its fingerprint rather
    /// than a clock, and uses the TTL only as a backstop.
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cache_root() -> Result<PathBuf, String> {
    let dir = dirs::data_dir().ok_or("no data dir")?;
    Ok(dir.join("rebase").join("crucible").join("cache"))
}

/// Filesystem-safe single path segment. Same rule as the transcript store: every
/// non-alphanumeric byte becomes `_`, so a scope/namespace/key can never climb
/// out of the cache directory no matter what the webview sends.
fn safe_segment(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// `<root>/<scope>/<namespace>/<key>-<hash>.json`. Scope is a project id (or
/// `_global` for things like model metadata that aren't project-specific).
///
/// The key keeps a readable prefix but carries a hash of the *original* string,
/// because `safe_segment` is deliberately lossy: it flattens every non-alphanumeric
/// byte, so `mistral:7b` and `mistral-7b` would otherwise share one entry. For a
/// cache holding per-model context windows, that collision means sending the wrong
/// `num_ctx` for a model — silently, for as long as the entry lives.
fn entry_path(root: &Path, scope: &str, namespace: &str, key: &str) -> PathBuf {
    let digest = Sha256::digest(key.as_bytes());
    let file = format!("{}-{:x}.json", safe_segment(key), digest);
    root.join(safe_segment(scope))
        .join(safe_segment(namespace))
        .join(file)
}

/// Read an entry, treating expired and unreadable alike: both are misses, and an
/// expired file is removed on the way out so it can't accumulate.
fn read_entry(path: &Path, now: u64) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let envelope: Envelope = serde_json::from_str(&raw).ok()?;
    if envelope.expires_at.is_some_and(|exp| now >= exp) {
        let _ = std::fs::remove_file(path);
        return None;
    }
    Some(envelope.value)
}

fn write_entry(path: &Path, value: String, ttl_ms: Option<u64>, now: u64) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let envelope = Envelope {
        value,
        created_at: now,
        expires_at: ttl_ms.map(|ttl| now.saturating_add(ttl)),
    };
    let body = serde_json::to_string(&envelope).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

/// Cached value, or `None` on a miss or an expired entry.
#[tauri::command]
pub fn cache_get(scope: String, namespace: String, key: String) -> Result<Option<String>, String> {
    let path = entry_path(&cache_root()?, &scope, &namespace, &key);
    Ok(read_entry(&path, now_ms()))
}

/// Store `value` (an opaque JSON string). `ttl_ms` absent means it never expires.
#[tauri::command]
pub fn cache_set(
    scope: String,
    namespace: String,
    key: String,
    value: String,
    ttl_ms: Option<u64>,
) -> Result<(), String> {
    let path = entry_path(&cache_root()?, &scope, &namespace, &key);
    write_entry(&path, value, ttl_ms, now_ms())
}

/// Drop one entry. Missing entries are not an error — callers invalidate
/// speculatively.
#[tauri::command]
pub fn cache_invalidate(scope: String, namespace: String, key: String) -> Result<(), String> {
    let path = entry_path(&cache_root()?, &scope, &namespace, &key);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Drop every entry in a namespace (e.g. all of a project's grounding).
#[tauri::command]
pub fn cache_invalidate_namespace(scope: String, namespace: String) -> Result<(), String> {
    let dir = cache_root()?
        .join(safe_segment(&scope))
        .join(safe_segment(&namespace));
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "rebase-cache-{}-{name}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn round_trips_an_opaque_value() {
        let root = tmp_root("round-trip");
        let path = entry_path(&root, "proj-1", "project-grounding", "summary");

        write_entry(&path, r#"{"section":"Overview"}"#.into(), None, 1_000).unwrap();
        assert_eq!(
            read_entry(&path, 9_999_999),
            Some(r#"{"section":"Overview"}"#.into()),
            "an entry with no TTL never expires",
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn expired_entries_miss_and_are_removed_on_read() {
        let root = tmp_root("expiry");
        let path = entry_path(&root, "proj-1", "ollama-models", "qwen2_5-coder");

        write_entry(&path, "{}".into(), Some(500), 1_000).unwrap();
        assert_eq!(read_entry(&path, 1_400), Some("{}".into()), "still inside the TTL");
        assert!(path.exists());

        // Expiry is inclusive at the boundary, and the read sweeps the file.
        assert_eq!(read_entry(&path, 1_500), None);
        assert!(!path.exists(), "an expired entry must not linger on disk");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_corrupt_entry_is_a_miss_not_an_error() {
        let root = tmp_root("corrupt");
        let path = entry_path(&root, "proj-1", "rolling-memory", "entries");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"not json at all").unwrap();

        assert_eq!(read_entry(&path, 1_000), None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn traversal_in_any_segment_stays_inside_the_cache_root() {
        let root = tmp_root("traversal");
        let path = entry_path(&root, "../../etc", "..", "../../../passwd");
        assert!(
            path.starts_with(&root),
            "escaped the cache root: {}",
            path.display(),
        );
        // Every dangerous component was flattened into a single safe segment.
        assert_eq!(path.parent().unwrap(), root.join("______etc").join("__"));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("_________passwd-"));
    }

    #[test]
    fn keys_differing_only_in_punctuation_do_not_collide() {
        // `safe_segment` flattens punctuation, and Ollama model names are full of
        // it. Without the hash suffix these would share one entry — and this
        // cache holds per-model context windows, so a collision means sending
        // the wrong `num_ctx` for one of them.
        let root = tmp_root("injectivity");
        let a = entry_path(&root, "_global", "ollama-models", "mistral:7b");
        let b = entry_path(&root, "_global", "ollama-models", "mistral-7b");
        assert_ne!(a, b);

        // Host scoping rides on the same mechanism: two Ollama hosts can have
        // different modelfiles for the same model name.
        let local = entry_path(&root, "_global", "ollama-models", "http://localhost:11434\0qwen");
        let remote = entry_path(&root, "_global", "ollama-models", "http://box:11434\0qwen");
        assert_ne!(local, remote);
    }

    #[test]
    fn the_same_key_always_resolves_to_the_same_path() {
        let root = tmp_root("stability");
        assert_eq!(
            entry_path(&root, "p", "ns", "qwen2.5-coder"),
            entry_path(&root, "p", "ns", "qwen2.5-coder"),
        );
    }

    #[test]
    fn distinct_scopes_and_namespaces_do_not_collide() {
        let root = tmp_root("scoping");
        let a = entry_path(&root, "proj-a", "project-grounding", "summary");
        let b = entry_path(&root, "proj-b", "project-grounding", "summary");
        let c = entry_path(&root, "proj-a", "rolling-memory", "summary");
        assert_ne!(a, b);
        assert_ne!(a, c);
    }
}
