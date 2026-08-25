//! Crucible desktop-side support: streams Ollama chat into the webview, manages
//! the local index cache (extracting the archive the agent produced), serves the
//! bundled indexer binary for upload, and edits the control-plane exec allowlist.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::Engine;
use futures_util::StreamExt;
use serde::Deserialize;
use tauri::{ipc::Channel, State};
use tokio::sync::oneshot;

use rebase_core::config::AppConfig;
use rebase_core::oidc::Auth;

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

// --- Chat transcript persistence -------------------------------------------

/// Per-project transcript directory: `~/transcripts/{safe_project_id}/`.
fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let dir = home.join("transcripts").join(safe_segment(project_id));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// One-time migration: move the old flat `~/transcripts/{pid}.jsonl` into the
/// per-project directory as `legacy.jsonl` and write an initial `meta.json`.
/// No-op when already migrated or when no old file exists.
fn maybe_migrate(project_id: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    let old = home
        .join("transcripts")
        .join(format!("{}.jsonl", safe_segment(project_id)));
    if !old.exists() {
        return Ok(());
    }
    let dir = project_dir(project_id)?;
    let new_path = dir.join("legacy.jsonl");
    if new_path.exists() {
        return Ok(());
    }
    let mtime = std::fs::metadata(&old)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    std::fs::rename(&old, &new_path).map_err(|e| e.to_string())?;
    let meta = serde_json::json!([{
        "id": "legacy",
        "title": "Previous conversation",
        "createdAt": mtime,
        "lastMessageAt": mtime,
    }]);
    std::fs::write(dir.join("meta.json"), meta.to_string()).map_err(|e| e.to_string())
}

/// List all conversations for a project. Runs migration transparently on first
/// call. Returns a JSON string (array of `ConversationMeta`) ordered newest-first.
#[tauri::command]
pub async fn transcript_list(project_id: String) -> Result<String, String> {
    maybe_migrate(&project_id)?;
    let meta_path = project_dir(&project_id)?.join("meta.json");
    match std::fs::read_to_string(&meta_path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("[]".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// Load all JSONL lines for one conversation. Returns `[]` when not found yet.
#[tauri::command]
pub async fn transcript_load_conversation(
    project_id: String,
    conversation_id: String,
) -> Result<Vec<String>, String> {
    let path = project_dir(&project_id)?
        .join(format!("{}.jsonl", safe_segment(&conversation_id)));
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(String::from)
            .collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}

/// Append JSONL lines to a specific conversation's file.
#[tauri::command]
pub async fn transcript_append_to(
    project_id: String,
    conversation_id: String,
    lines: Vec<String>,
) -> Result<(), String> {
    use std::io::Write;
    let path = project_dir(&project_id)?
        .join(format!("{}.jsonl", safe_segment(&conversation_id)));
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    for line in &lines {
        writeln!(file, "{}", line).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Atomically rewrite the project's `meta.json` with the provided JSON string.
#[tauri::command]
pub async fn transcript_save_meta(
    project_id: String,
    meta_json: String,
) -> Result<(), String> {
    std::fs::write(project_dir(&project_id)?.join("meta.json"), meta_json)
        .map_err(|e| e.to_string())
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
    #[serde(default)]
    pub content: String,
    /// For `role:"tool"` result messages.
    #[serde(default)]
    pub tool_name: Option<String>,
    /// For `role:"assistant"` messages that previously called tools (history).
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
}

/// The assistant's reply: streamed `content` (also pushed live over the channel)
/// plus any `tool_calls` the model wants the app to execute. A cancelled step
/// still returns whatever streamed before the stop — the user already read those
/// tokens, so throwing them away would rewrite the transcript under them.
#[derive(serde::Serialize)]
pub struct ChatResult {
    pub content: String,
    pub tool_calls: Vec<serde_json::Value>,
    pub cancelled: bool,
    /// The stream was cut short because the model began repeating itself (a short
    /// unit over and over) — a runaway from a missing stop token / flaky custom
    /// parser, not a normal completion. Content is trimmed of the repeated tail.
    pub degenerated: bool,
}

/// In-flight `crucible_chat` calls, keyed by the caller's `requestId`.
///
/// Without this, stopping the agent only flipped a flag in the webview: the HTTP
/// body kept streaming and Ollama kept generating, so Stop took as long as the
/// answer did. Firing the sender breaks the read loop and drops the response,
/// which closes the connection and actually halts generation server-side.
#[derive(Default)]
pub struct ChatCancels {
    live: Mutex<HashMap<String, oneshot::Sender<()>>>,
    /// Ids cancelled before they were ever armed.
    ///
    /// `invoke` preserves IPC *delivery* order but not *execution* order: an
    /// async command is spawned onto the runtime and doesn't run `register`
    /// until first polled, while `crucible_chat_cancel` is sync and runs
    /// straight away. A cancel landing in that gap would otherwise find an
    /// empty map, no-op, and leave a stream nobody can ever stop — the exact
    /// bug this registry exists to prevent, reappearing silently.
    precancelled: Mutex<HashSet<String>>,
}

impl ChatCancels {
    /// Arm cancellation for `id`, returning a receiver that is *already* resolved
    /// if a cancel arrived first. A repeat id drops the previous sender, whose
    /// receiver then resolves immediately — the right outcome for a duplicate.
    fn register(&self, id: &str) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        if self.precancelled.lock().unwrap().remove(id) {
            // Fire immediately; the loop will break on its first poll.
            let _ = tx.send(());
            return rx;
        }
        self.live.lock().unwrap().insert(id.to_string(), tx);
        rx
    }

    /// Fire the cancel for `id`. Records the id as pre-cancelled when nothing is
    /// armed yet, so a `register` that has not run cannot miss it.
    fn cancel(&self, id: &str) {
        match self.live.lock().unwrap().remove(id) {
            Some(tx) => {
                let _ = tx.send(());
            }
            None => {
                self.precancelled.lock().unwrap().insert(id.to_string());
            }
        }
    }

    /// Drop any armed sender for `id` without firing it (the request finished).
    fn forget(&self, id: &str) {
        self.live.lock().unwrap().remove(id);
        self.precancelled.lock().unwrap().remove(id);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.live.lock().unwrap().len()
    }

    #[cfg(test)]
    fn precancelled_len(&self) -> usize {
        self.precancelled.lock().unwrap().len()
    }
}

/// Removes the registry entry however the chat exits — success, error, or cancel.
/// Without it the map grows one dead sender per completed request.
struct CancelGuard {
    cancels: Arc<ChatCancels>,
    id: String,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.cancels.forget(&self.id);
    }
}

/// Stop an in-flight `crucible_chat`. Safe to call for an id that has finished,
/// was never issued, or has not been armed yet (see `ChatCancels::precancelled`).
#[tauri::command]
pub fn crucible_chat_cancel(request_id: String, cancels: State<'_, Arc<ChatCancels>>) {
    cancels.cancel(&request_id);
}

/// Consume Ollama's NDJSON response into a `ChatResult`, forwarding content
/// tokens as they arrive and stopping early if `cancel_rx` fires.
///
/// Generic over the byte stream and the token sink so it can be driven from a
/// test without a live server: the command passes a reqwest stream and a Tauri
/// channel, tests pass `stream::iter` and a closure. This is the part of the
/// chat path most worth pinning — the framing, and the cancellation semantics
/// that decide whether Stop actually stops.
// --- Degeneration guard ----------------------------------------------------
//
// A model with no stop token (or a flaky custom renderer/parser — increasingly
// common: `TEMPLATE {{ .Prompt }}` + `RENDERER x` + `PARSER x` and no
// `PARAMETER stop`) can run away emitting one short unit forever, e.g.
// `</assistant></assistant>…`, pinning the machine until Ollama is killed. Since
// Re:Base points at whatever model the user configures, we can't trust any of
// them to self-terminate — so we watch the output and cut it off if it collapses
// into repetition. Model-agnostic: it keys on the *shape* (a short unit repeated
// far past anything natural), not on any specific token.

/// Smallest period `u` (1..=MAX_UNIT) such that the tail of `s` is `u` repeated
/// across at least MIN_SPAN chars and MIN_REPEATS times, or None. Thresholds are
/// set high enough that natural text (even a long `----` rule or `...`) never
/// trips it: it takes ~120+ chars of pure repetition.
fn degenerate_period(s: &str) -> Option<usize> {
    const WINDOW: usize = 512;
    const MAX_UNIT: usize = 32;
    const MIN_REPEATS: usize = 10;
    const MIN_SPAN: usize = 120;

    let tail: Vec<char> = {
        let mut v: Vec<char> = s.chars().rev().take(WINDOW).collect();
        v.reverse();
        v
    };
    let n = tail.len();
    for unit in 1..=MAX_UNIT {
        let need = (unit * MIN_REPEATS).max(MIN_SPAN);
        if need > n {
            break;
        }
        let start = n - need;
        // The whole `need`-char span must be `unit`-periodic (reference = the
        // first `unit` chars of the span).
        let periodic = (0..need).all(|k| tail[start + k] == tail[start + k % unit]);
        if periodic {
            return Some(unit);
        }
    }
    None
}

/// Strip a runaway repeated suffix down to a single occurrence of the unit, so
/// the surfaced answer keeps the real content without the spam tail.
fn trim_degenerate_tail(s: &str) -> String {
    let Some(unit) = degenerate_period(s) else {
        return s.to_string();
    };
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    let unit_chars = &chars[n - unit..];
    let mut end = n;
    while end >= unit && &chars[end - unit..end] == unit_chars {
        end -= unit;
    }
    end += unit; // keep one occurrence
    chars[..end.min(n)].iter().collect()
}

async fn drain_ndjson<S, B, E>(
    mut stream: S,
    mut cancel_rx: Option<oneshot::Receiver<()>>,
    mut on_token: impl FnMut(&str),
) -> Result<ChatResult, String>
where
    S: futures_util::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    let mut buf: Vec<u8> = Vec::new();
    let mut content = String::new();
    let mut tool_calls: Vec<serde_json::Value> = Vec::new();
    let mut cancelled = false;
    let mut degenerated = false;

    loop {
        // `biased` so the cancel is checked first and Stop takes effect on the
        // very next chunk boundary. Without it `select!` picks at random among
        // ready branches, which would make cancellation land probabilistically.
        let next = match cancel_rx.as_mut() {
            Some(rx) => tokio::select! {
                biased;
                _ = &mut *rx => { cancelled = true; break }
                chunk = stream.next() => chunk,
            },
            None => stream.next().await,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| e.to_string())?;
        buf.extend_from_slice(chunk.as_ref());

        // Frames can split mid-line, so only complete lines are parsed and the
        // remainder stays buffered for the next chunk.
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1];
            if line.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(line) {
                if let Some(msg) = v.get("message") {
                    if let Some(tok) = msg.get("content").and_then(|c| c.as_str()) {
                        if !tok.is_empty() {
                            content.push_str(tok);
                            on_token(tok);
                            // Cut a runaway model off rather than stream forever.
                            if degenerate_period(&content).is_some() {
                                degenerated = true;
                                break;
                            }
                        }
                    }
                    if let Some(tc) = msg.get("tool_calls").and_then(|c| c.as_array()) {
                        tool_calls.extend(tc.iter().cloned());
                    }
                }
                if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                    return Ok(ChatResult {
                        content,
                        tool_calls,
                        cancelled: false,
                        degenerated: false,
                    });
                }
            }
        }
        if degenerated {
            break;
        }
    }

    // Fell out of the loop: cancelled, degenerated, or the stream ended without a
    // `done` frame. All keep the partial content; a degenerate run also trims its
    // repeated tail so the surfaced answer isn't buried in spam.
    if degenerated {
        content = trim_degenerate_tail(&content);
    }
    Ok(ChatResult {
        content,
        tool_calls,
        cancelled,
        degenerated,
    })
}

/// One chat step against Ollama. Forwards content tokens over the channel as they
/// stream, and returns the final assistant message (content + tool_calls). When
/// `tools` is provided, the model may return tool_calls instead of (or with) text.
///
/// `num_ctx` matters more than it looks: without it Ollama uses the *modelfile's*
/// context window (commonly 4096) whatever the model actually supports, and
/// silently drops the oldest tokens — so any budgeting we do up-stack is fiction
/// unless the window we budgeted against is the one we sent.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn crucible_chat(
    ollama: String,
    model: String,
    messages: Vec<ChatMessage>,
    tools: Option<serde_json::Value>,
    request_id: Option<String>,
    temperature: Option<f32>,
    num_ctx: Option<u32>,
    format: Option<String>,
    on_token: Channel<String>,
    cancels: State<'_, Arc<ChatCancels>>,
) -> Result<ChatResult, String> {
    let msgs: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let mut o = serde_json::Map::new();
            o.insert("role".into(), serde_json::json!(m.role));
            o.insert("content".into(), serde_json::json!(m.content));
            if let Some(tn) = &m.tool_name {
                o.insert("tool_name".into(), serde_json::json!(tn));
            }
            if let Some(tc) = &m.tool_calls {
                o.insert("tool_calls".into(), tc.clone());
            }
            serde_json::Value::Object(o)
        })
        .collect();

    let mut body = serde_json::json!({ "model": model, "messages": msgs, "stream": true });
    if let Some(t) = tools {
        body["tools"] = t;
    }
    // `format: "json"` constrains the model to emit a single JSON object, which is
    // what the planner/validator/post-validator roles want. It removes most of the
    // "model wrapped its JSON in prose" parse failures at the source.
    if let Some(f) = format {
        body["format"] = serde_json::json!(f);
    }
    let mut options = serde_json::Map::new();
    if let Some(t) = temperature {
        options.insert("temperature".into(), serde_json::json!(t));
    }
    if let Some(n) = num_ctx {
        options.insert("num_ctx".into(), serde_json::json!(n));
    }
    if !options.is_empty() {
        body["options"] = serde_json::Value::Object(options);
    }

    // Arm cancellation before the request goes out, so a Stop that lands during
    // connect/headers is honoured rather than deferred.
    let mut cancel_rx = request_id.as_deref().map(|id| cancels.register(id));
    let _guard = request_id.as_deref().map(|id| CancelGuard {
        cancels: Arc::clone(&cancels),
        id: id.to_string(),
    });

    let url = format!("{}/api/chat", ollama.trim_end_matches('/'));
    // No overall timeout: a long generation is normal and cancellation is the
    // right control for it. `connect_timeout` still bounds an unreachable host,
    // which would otherwise hang the turn with no feedback.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let request = client.post(&url).json(&body).send();

    // Ollama doesn't flush response headers until the model is resident, so on a
    // cold large model this await alone can be 20-60s. Racing the cancel here is
    // what makes Stop land *during* the load rather than after it.
    let sent = match cancel_rx.as_mut() {
        Some(rx) => tokio::select! {
            biased;
            _ = &mut *rx => {
                return Ok(ChatResult {
                    content: String::new(),
                    tool_calls: Vec::new(),
                    cancelled: true,
                    degenerated: false,
                })
            }
            r = request => r,
        },
        None => request.await,
    };
    let resp = sent.map_err(|e| format!("POST {url} (is Ollama running?): {e}"))?;
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

    drain_ndjson(resp.bytes_stream(), cancel_rx, |tok| {
        let _ = on_token.send(tok.to_string());
    })
    .await
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

/// Atomically add commands to the control plane's exec allowlist (POST add op),
/// which re-pushes the merged list to every connected agent. Unlike a full PUT
/// replace, this never clears the list and won't clobber concurrent admin edits
/// — the right primitive for Crucible's auto-grant.
#[tauri::command]
pub async fn exec_allowlist_add(
    auth: State<'_, Arc<Auth>>,
    control_plane: Option<String>,
    commands: Vec<String>,
    source: Option<String>,
) -> Result<(), String> {
    let base = cp_http_base(control_plane)?;
    let bearer = auth
        .bearer()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("not signed in")?;
    reqwest::Client::new()
        .post(format!("{base}/api/server/exec-allowlist"))
        .bearer_auth(bearer)
        .json(&serde_json::json!({ "add": commands, "source": source.unwrap_or_else(|| "crucible".into()) }))
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
    use tokio::sync::oneshot::error::TryRecvError;

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

    #[test]
    fn cancel_registry_fires_the_armed_receiver() {
        let cancels = ChatCancels::default();
        let mut rx = cancels.register("req-1");
        assert_eq!(cancels.len(), 1);

        // Pending, specifically — not merely "not yet a value". `is_err()` alone
        // would also pass for a closed channel, which is the opposite state.
        assert_eq!(rx.try_recv(), Err(TryRecvError::Empty));

        cancels.cancel("req-1");
        assert_eq!(rx.try_recv(), Ok(()));
        assert_eq!(cancels.len(), 0, "cancel must remove the entry");
    }

    #[test]
    fn cancelling_a_finished_request_is_a_no_op() {
        let cancels = ChatCancels::default();
        let rx = cancels.register("req-1");
        cancels.forget("req-1"); // the chat completed
        drop(rx);

        cancels.cancel("req-1");
        // The id was live and is now gone, so this must not be recorded as an
        // early cancel — a later request reusing the id would die instantly.
        assert_eq!(cancels.len(), 0);
        assert_eq!(cancels.precancelled_len(), 1);
        cancels.forget("req-1");
        assert_eq!(cancels.precancelled_len(), 0);
    }

    #[test]
    fn a_cancel_that_arrives_before_registration_is_not_lost() {
        // `invoke` preserves delivery order but not execution order: the sync
        // cancel command can run before the spawned async chat polls far enough
        // to arm itself. The receiver must come back already fired.
        let cancels = ChatCancels::default();
        cancels.cancel("req-1");
        assert_eq!(cancels.precancelled_len(), 1);

        let mut rx = cancels.register("req-1");
        assert_eq!(rx.try_recv(), Ok(()), "must resolve immediately");
        assert_eq!(cancels.precancelled_len(), 0, "the marker is consumed once");
        assert_eq!(cancels.len(), 0, "a pre-cancelled id is never armed");
    }

    #[test]
    fn a_pre_cancel_applies_only_to_the_next_registration() {
        let cancels = ChatCancels::default();
        cancels.cancel("req-1");
        let _consumed = cancels.register("req-1");

        // A second run reusing the id must start clean.
        let mut second = cancels.register("req-1");
        assert_eq!(second.try_recv(), Err(TryRecvError::Empty));
    }

    /// Feed `chunks` through the drain loop, optionally cancelling first.
    async fn drain(
        chunks: Vec<&'static str>,
        cancel: Option<oneshot::Receiver<()>>,
    ) -> (ChatResult, Vec<String>) {
        let stream = futures_util::stream::iter(
            chunks
                .into_iter()
                .map(|c| Ok::<_, std::io::Error>(c.as_bytes().to_vec())),
        );
        let mut tokens = Vec::new();
        let result = drain_ndjson(stream, cancel, |t| tokens.push(t.to_string()))
            .await
            .unwrap();
        (result, tokens)
    }

    #[tokio::test]
    async fn a_done_frame_ends_the_stream_as_not_cancelled() {
        let (result, tokens) = drain(
            vec![
                r#"{"message":{"content":"Hel"}}"#,
                "\n",
                r#"{"message":{"content":"lo"}}"#,
                "\n",
                r#"{"done":true}"#,
                "\n",
            ],
            None,
        )
        .await;

        assert_eq!(result.content, "Hello");
        assert!(!result.cancelled);
        assert_eq!(tokens, vec!["Hel", "lo"], "each token forwarded as it arrives");
    }

    #[tokio::test]
    async fn a_frame_split_across_chunks_is_reassembled() {
        // The framing bug that would be invisible without a test: a JSON object
        // arriving in three pieces must parse once, not zero or three times.
        let (result, _) = drain(
            vec![r#"{"message":{"cont"#, r#"ent":"split"}}"#, "\n", r#"{"done":true}"#, "\n"],
            None,
        )
        .await;
        assert_eq!(result.content, "split");
    }

    #[tokio::test]
    async fn a_cancel_stops_the_loop_and_keeps_what_arrived() {
        let (tx, rx) = oneshot::channel();
        tx.send(()).unwrap();

        // Already-fired cancel: `biased` must pick it over the ready chunks, so
        // nothing is consumed at all.
        let (result, tokens) = drain(vec![r#"{"message":{"content":"never"}}"#, "\n"], Some(rx)).await;

        assert!(result.cancelled);
        assert_eq!(result.content, "", "cancel wins over an already-buffered chunk");
        assert!(tokens.is_empty());
    }

    #[tokio::test]
    async fn a_stream_that_ends_without_done_keeps_its_partial_content() {
        // A dropped connection mid-answer. The partial reply is what the user
        // already read, so it must survive rather than being discarded.
        let (result, _) = drain(vec![r#"{"message":{"content":"partial"}}"#, "\n"], None).await;
        assert_eq!(result.content, "partial");
        assert!(!result.cancelled, "an ended stream is not a cancellation");
    }

    #[test]
    fn degenerate_period_flags_repetition_and_ignores_natural_text() {
        // The real failure: a turn-close tag repeated forever.
        let runaway = format!("Here is the answer.{}", "</assistant>".repeat(30));
        assert_eq!(degenerate_period(&runaway), Some("</assistant>".chars().count()));

        // A single character spammed.
        assert_eq!(degenerate_period(&"x".repeat(200)), Some(1));

        // Natural text must never trip it, nor a short/rule-length repeat.
        assert_eq!(
            degenerate_period(
                "The indexer signs each release binary and the agent verifies that \
                 signature against a pinned public key before running it, so nothing \
                 unverified ever runs."
            ),
            None
        );
        assert_eq!(degenerate_period(&"-".repeat(80)), None, "80 dashes is under the span threshold");
        assert_eq!(degenerate_period("done..."), None);
    }

    #[test]
    fn trim_degenerate_tail_keeps_content_and_one_unit() {
        let runaway = format!("Real answer.{}", "</assistant>".repeat(40));
        assert_eq!(trim_degenerate_tail(&runaway), "Real answer.</assistant>");
        assert_eq!(trim_degenerate_tail("just fine"), "just fine", "non-degenerate is unchanged");
    }

    #[tokio::test]
    async fn a_runaway_model_is_cut_off_and_flagged() {
        let mut chunks: Vec<&'static str> = vec![r#"{"message":{"content":"ANSWER "}}"#, "\n"];
        // 15 turn-close tags (180 chars) — well past the guard's threshold.
        for _ in 0..15 {
            chunks.push(r#"{"message":{"content":"</assistant>"}}"#);
            chunks.push("\n");
        }
        // A frame after the runaway: it must never be consumed (we stopped early).
        chunks.push(r#"{"message":{"content":"SHOULD_NOT_APPEAR"}}"#);
        chunks.push("\n");

        let (result, _) = drain(chunks, None).await;
        assert!(result.degenerated, "runaway repetition should set degenerated");
        assert!(!result.cancelled, "a runaway is not a user cancel");
        assert!(result.content.starts_with("ANSWER "), "the real content is kept");
        assert!(!result.content.contains("SHOULD_NOT_APPEAR"), "the stream stops at detection");
        assert!(
            result.content.ends_with("</assistant>")
                && !result.content.ends_with("</assistant></assistant>"),
            "tail trimmed to a single unit: {:?}",
            result.content
        );
    }

    #[tokio::test]
    async fn tool_calls_accumulate_across_frames() {
        let (result, _) = drain(
            vec![
                r#"{"message":{"tool_calls":[{"function":{"name":"read_file"}}]}}"#,
                "\n",
                r#"{"message":{"tool_calls":[{"function":{"name":"grep"}}]}}"#,
                "\n",
                r#"{"done":true}"#,
                "\n",
            ],
            None,
        )
        .await;
        assert_eq!(result.tool_calls.len(), 2);
    }

    #[tokio::test]
    async fn blank_and_unparseable_lines_are_skipped_not_fatal() {
        let (result, _) = drain(
            vec!["\n", "not json\n", r#"{"message":{"content":"ok"}}"#, "\n", r#"{"done":true}"#, "\n"],
            None,
        )
        .await;
        assert_eq!(result.content, "ok");
    }

    #[test]
    fn guard_drops_the_entry_on_every_exit_path() {
        let cancels = Arc::new(ChatCancels::default());
        {
            let _rx = cancels.register("req-1");
            let _guard = CancelGuard {
                cancels: Arc::clone(&cancels),
                id: "req-1".into(),
            };
            assert_eq!(cancels.len(), 1);
        }
        assert_eq!(cancels.len(), 0, "a completed chat must not leak its sender");
    }

    #[test]
    fn dropping_the_sender_still_wakes_the_receiver() {
        // A duplicate request id replaces the previous sender; the displaced
        // receiver must resolve so its stream doesn't hang forever. Asserting
        // `Closed` specifically — `is_err()` would also hold for `Empty`, i.e.
        // for the broken case where the old sender was left armed.
        let cancels = ChatCancels::default();
        let mut first = cancels.register("dup");
        let _second = cancels.register("dup");
        assert_eq!(first.try_recv(), Err(TryRecvError::Closed));
        assert_eq!(cancels.len(), 1);
    }
}
