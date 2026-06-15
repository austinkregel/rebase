//! Crucible desktop-side support: streams Ollama chat into the webview, manages
//! the local index cache (extracting the archive the agent produced), serves the
//! bundled indexer binary for upload, and edits the control-plane exec allowlist.

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine;
use futures_util::StreamExt;
use serde::Deserialize;
use tauri::{ipc::Channel, State};

use crate::config::AppConfig;
use crate::oidc::Auth;

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

    let gz = flate2::read::GzDecoder::new(&bytes[..]);
    let mut archive = tar::Archive::new(gz);
    archive.unpack(&dir).map_err(|e| format!("extracting index: {e}"))?;
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
        .map_err(|e| format!("POST {url} (is Ollama running?): {e}"))?
        .error_for_status()
        .map_err(|e| format!("Ollama chat error: {e}"))?;

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
