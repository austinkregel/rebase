//! Crucible desktop-side support: streams Ollama chat into the webview, manages
//! the local index cache (extracting the archive the agent produced), serves the
//! bundled indexer binary for upload, and edits the control-plane exec allowlist.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use futures_util::StreamExt;
use serde::Deserialize;
use tauri::{ipc::Channel, State};

use crate::config::AppConfig;
use crate::oidc::Auth;

/// Caps for extracting the (agent-produced, untrusted) index archive — guards
/// against decompression bombs.
const MAX_INDEX_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB decompressed
const MAX_INDEX_ENTRIES: usize = 200_000;

// --- Local index cache -----------------------------------------------------

fn cache_root() -> Result<PathBuf, String> {
    let dir = dirs::data_dir().ok_or("no data dir")?;
    Ok(dir.join("rebase").join("crucible"))
}

/// Filesystem-safe single path segment from an arbitrary string.
fn safe_segment(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn index_dir_for(client_id: &str, root: &str) -> Result<PathBuf, String> {
    Ok(cache_root()?
        .join(safe_segment(client_id))
        .join(safe_segment(root))
        .join(".rebase-index"))
}

/// Absolute path of the local LanceDB index for a project's primary root.
#[tauri::command]
pub fn crucible_local_index_dir(client_id: String, root: String) -> Result<String, String> {
    Ok(index_dir_for(&client_id, &root)?.to_string_lossy().into_owned())
}

/// Whether an extracted index already exists locally for this project root.
#[tauri::command]
pub fn crucible_index_exists(client_id: String, root: String) -> Result<bool, String> {
    Ok(index_dir_for(&client_id, &root)?.exists())
}

/// Extract the gzip-tar index archive (downloaded from the agent, base64-encoded)
/// into the local cache, replacing any previous copy. The archive's entries are
/// relative to the index dir, so they unpack straight in.
#[tauri::command]
pub fn crucible_extract_index(
    archive: String,
    client_id: String,
    root: String,
) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(archive.as_bytes())
        .map_err(|e| format!("decoding archive: {e}"))?;
    let dir = index_dir_for(&client_id, &root)?;
    if dir.exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    extract_targz(&bytes, &dir)
}

/// Lexically resolve `..`/`.` in `target` (without touching the filesystem) and
/// confirm it stays under `dest`. Returns the normalized path when safe.
fn within(dest: &Path, target: &Path) -> Option<PathBuf> {
    let mut out = dest.to_path_buf();
    for comp in target.strip_prefix(dest).ok()?.components() {
        match comp {
            Component::ParentDir => {
                if !out.pop() || !out.starts_with(dest) {
                    return None;
                }
            }
            Component::CurDir => {}
            Component::Normal(c) => out.push(c),
            // Absolute / prefix components can't appear in a relative entry path.
            _ => return None,
        }
    }
    out.starts_with(dest).then_some(out)
}

/// Extract a gzip-tar into `dest` defensively: reject path-traversal and link
/// entries (zip-slip), don't honor archived permissions (no setuid), and cap
/// entry count + total size (decompression bomb). The archive is produced by the
/// agent, so it's treated as untrusted input.
fn extract_targz(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let dest = std::fs::canonicalize(dest).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(gz);
    archive.set_preserve_permissions(false);
    archive.set_overwrite(true);

    let mut total: u64 = 0;
    let mut count: usize = 0;
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        count += 1;
        if count > MAX_INDEX_ENTRIES {
            return Err("index archive has too many entries".into());
        }
        let etype = entry.header().entry_type();
        if etype.is_symlink() || etype.is_hard_link() {
            return Err("refusing link entry in index archive".into());
        }
        total = total.saturating_add(entry.header().size().unwrap_or(0));
        if total > MAX_INDEX_BYTES {
            return Err("index archive too large (possible decompression bomb)".into());
        }
        let rel = entry.path().map_err(|e| e.to_string())?.into_owned();
        let target = dest.join(&rel);
        let safe = within(&dest, &target)
            .ok_or_else(|| format!("refusing path-traversal entry: {}", rel.display()))?;
        if let Some(parent) = safe.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        entry.unpack(&safe).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// --- Ollama chat (streaming) -----------------------------------------------

#[derive(Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Stream a chat completion from Ollama, forwarding each content token over the
/// channel. Resolves when the model signals `done`. Ollama emits newline-
/// delimited JSON objects shaped `{ "message": { "content": ... }, "done": bool }`.
#[tauri::command]
pub async fn crucible_chat(
    ollama: String,
    model: String,
    messages: Vec<ChatMessage>,
    on_token: Channel<String>,
) -> Result<(), String> {
    let body = serde_json::json!({
        "model": model,
        "messages": messages
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
        "stream": true,
    });
    let url = format!("{}/api/chat", ollama.trim_end_matches('/'));
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("POST {url} (is Ollama running?): {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        // Ollama returns 404 with `{"error":"model '…' not found"}` when the chat
        // model isn't pulled — surface that body instead of a bare status code.
        let detail = resp.text().await.unwrap_or_default();
        let detail = detail.trim();
        if status.as_u16() == 404 {
            return Err(format!(
                "Ollama has no model '{model}'. Pull it with `ollama pull {model}`, or set a different chat model in settings. ({detail})"
            ));
        }
        return Err(format!("Ollama chat {status}: {detail}"));
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1];
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) {
                if let Some(tok) = v
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if !tok.is_empty() {
                        let _ = on_token.send(tok.to_string());
                    }
                }
                if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

// --- Control-plane exec allowlist ------------------------------------------

/// Derive the control plane's HTTP origin from its dashboard WS URL.
fn cp_http_base(control_plane: Option<String>) -> Result<String, String> {
    let cfg = AppConfig::load().map_err(|e| e.to_string())?;
    let cp = match control_plane {
        Some(name) => cfg.control_plane(&name).cloned(),
        None => cfg.control_planes.first().cloned(),
    }
    .ok_or("no control plane configured")?;
    let u = url::Url::parse(&cp.url).map_err(|e| e.to_string())?;
    let scheme = if u.scheme() == "wss" { "https" } else { "http" };
    let host = u.host_str().ok_or("control plane url has no host")?;
    Ok(match u.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    })
}

#[tauri::command]
pub async fn exec_allowlist_get(
    auth: State<'_, Arc<Auth>>,
    control_plane: Option<String>,
) -> Result<Vec<String>, String> {
    let base = cp_http_base(control_plane)?;
    let bearer = auth
        .bearer()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("not signed in")?;
    #[derive(Deserialize)]
    struct Resp {
        #[serde(default)]
        commands: Vec<String>,
    }
    let resp = reqwest::Client::new()
        .get(format!("{base}/api/server/exec-allowlist"))
        .bearer_auth(bearer)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<Resp>()
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp.commands)
}

#[tauri::command]
pub async fn exec_allowlist_set(
    auth: State<'_, Arc<Auth>>,
    control_plane: Option<String>,
    commands: Vec<String>,
) -> Result<(), String> {
    let base = cp_http_base(control_plane)?;
    let bearer = auth
        .bearer()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("not signed in")?;
    reqwest::Client::new()
        .put(format!("{base}/api/server/exec-allowlist"))
        .bearer_auth(bearer)
        .json(&serde_json::json!({ "commands": commands }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_allows_nested_and_rejects_escape() {
        let dest = Path::new("/cache/idx");
        // legitimate entries
        assert!(within(dest, Path::new("/cache/idx/data/a.lance")).is_some());
        assert!(within(dest, &Path::new("/cache/idx").join("./manifest.json")).is_some());
        assert!(within(dest, Path::new("/cache/idx")).is_some());
        // path traversal out of dest
        assert!(within(dest, Path::new("/cache/idx/../evil")).is_none());
        assert!(within(dest, Path::new("/cache/idx/a/../../evil")).is_none());
        // unrelated absolute path
        assert!(within(dest, Path::new("/etc/passwd")).is_none());
    }

    #[test]
    fn extract_targz_round_trips_and_blocks_traversal() {
        let tmp = std::env::temp_dir().join(format!("crucible-test-{}", std::process::id()));
        let src = tmp.join("src");
        let sub = src.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(src.join("manifest.json"), b"{}").unwrap();
        std::fs::write(sub.join("data.lance"), b"xyz").unwrap();

        let mut buf = Vec::new();
        {
            let enc = flate2::write::GzEncoder::new(&mut buf, flate2::Compression::default());
            let mut tar = tar::Builder::new(enc);
            tar.append_dir_all(".", &src).unwrap();
            tar.into_inner().unwrap().finish().unwrap();
        }

        let out = tmp.join("out");
        std::fs::create_dir_all(&out).unwrap();
        extract_targz(&buf, &out).unwrap();
        assert!(out.join("manifest.json").exists());
        assert!(out.join("sub").join("data.lance").exists());

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
