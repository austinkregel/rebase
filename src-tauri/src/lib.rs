mod cache;
mod codesearch;
mod crucible;
mod ollama;
mod transport;

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager, State};

use rebase_core::config::{AppConfig, ControlPlane};
use rebase_core::oidc::Auth;
use rebase_core::tokens::Credential;
use rebase_core::{connection, tokens};
use transport::Transport;

#[derive(Serialize)]
struct AuthStatus {
    authenticated: bool,
}

#[tauri::command]
fn list_control_planes() -> Result<Vec<ControlPlane>, String> {
    AppConfig::load()
        .map(|c| c.control_planes)
        .map_err(|e| e.to_string())
}

/// Network-free startup check: the gate only needs to know whether an auth
/// token is stored. Validation happens when we connect to the control plane.
#[tauri::command]
fn auth_status() -> Result<AuthStatus, String> {
    match tokens::load() {
        Ok(cred) => Ok(AuthStatus {
            authenticated: cred.is_some(),
        }),
        Err(e) => Err(e.to_string()),
    }
}

/// Begin CP-brokered sign-in: open the system browser at the control plane's
/// app-login endpoint with our `rebase://callback` redirect. The control plane
/// runs the OIDC/SSO flow and redirects back to the app with a token, which the
/// deep-link handler stores in the keychain.
#[tauri::command]
fn login(control_plane: Option<String>) -> Result<(), String> {
    let cfg = AppConfig::load().map_err(|e| e.to_string())?;
    let cp = match control_plane {
        Some(name) => cfg.control_plane(&name).cloned(),
        None => cfg.control_planes.first().cloned(),
    }
    .ok_or("no control plane configured")?;
    // Record the login we're about to start so the deep-link callback can be
    // matched against it (CSRF gate); the browser echoes `state` back once the
    // control plane preserves it.
    let state = uuid::Uuid::new_v4().to_string();
    rebase_core::pending_login::write(&state).map_err(|e| e.to_string())?;
    let url = auth_login_url(&cp, &state)?;
    open::that(&url).map_err(|e| format!("failed to open browser: {e}"))?;
    Ok(())
}

/// Non-browser credential entry (CI / power users): store a static token or the
/// machine client's id+secret. The CP-brokered `login` flow is the default.
#[tauri::command]
fn set_credentials(
    token: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<(), String> {
    let cred = match (token, client_id, client_secret) {
        (Some(token), _, _) if !token.trim().is_empty() => Credential::Token { token },
        (_, Some(client_id), Some(client_secret)) => Credential::Client {
            client_id,
            client_secret,
        },
        _ => return Err("provide a token, or both clientId and clientSecret".into()),
    };
    tokens::store(&cred).map_err(|e| e.to_string())
}

#[tauri::command]
fn logout() -> Result<(), String> {
    tokens::clear().map_err(|e| e.to_string())
}

#[tauri::command]
async fn connect(
    app: tauri::AppHandle,
    transport: State<'_, Arc<Transport>>,
    auth: State<'_, Arc<Auth>>,
    control_plane: String,
) -> Result<(), String> {
    let cfg = AppConfig::load().map_err(|e| e.to_string())?;
    let cp = cfg
        .control_plane(&control_plane)
        .ok_or_else(|| format!("unknown control plane '{control_plane}'"))?;

    // The control plane authenticates the Bearer token on the WS upgrade; we
    // just need one present. (Token validity is the CP's call, not ours.)
    let bearer = auth.bearer().await.map_err(|e| e.to_string())?;
    if bearer.is_none() {
        return Err("not signed in".into());
    }

    let plan = connection::plan_for(&cp.as_relay_profile(), bearer).map_err(|e| e.to_string())?;
    transport.connect(app, plan).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn disconnect(transport: State<'_, Arc<Transport>>) -> Result<(), String> {
    transport.disconnect().await;
    Ok(())
}

/// Semantic code search over a local LanceDB index built by rebase-indexer.
#[tauri::command]
async fn search_code(
    index_path: String,
    query: String,
    ollama: String,
    model: String,
    k: usize,
) -> Result<Vec<codesearch::Hit>, String> {
    codesearch::search(&index_path, &query, &ollama, &model, k)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn emit(
    transport: State<'_, Arc<Transport>>,
    event: String,
    data: Value,
) -> Result<bool, String> {
    Ok(transport.emit(&event, data).await)
}

/// Derive the control plane's browser sign-in URL from its dashboard WS URL.
/// e.g. wss://kratos.kregel.host:8443/ws/dashboard → https://kratos.kregel.host:8443/auth/app?redirect=rebase://callback
fn auth_login_url(cp: &rebase_core::config::ControlPlane, state: &str) -> Result<String, String> {
    cp.auth_login_url(state).map_err(|e| e.to_string())
}

/// Validate a token handed back over the deep link before we store it. The CP
/// returns either an opaque access token or a JWT; reject obvious garbage
/// (empty, whitespace, or a malformed dotted/JWT shape) so a bad redirect
/// surfaces as an error rather than a silently-broken session.
fn validate_deeplink_token(token: &str) -> Result<(), &'static str> {
    let t = token.trim();
    if t.is_empty() {
        return Err("missing token");
    }
    if t.chars().any(|c| c.is_whitespace()) {
        return Err("token contains whitespace");
    }
    // If it looks like a JWT (has dots), require three non-empty segments.
    if t.contains('.') {
        let segments: Vec<&str> = t.split('.').collect();
        if segments.len() != 3 || segments.iter().any(|s| s.is_empty()) {
            return Err("malformed JWT");
        }
    }
    Ok(())
}

/// Constant-time byte-slice equality. Manual (no new dep) so the `state`
/// comparison in `validate_callback` doesn't leak timing about how many leading
/// bytes matched. Unequal lengths are still rejected, but the loop always runs
/// over the shorter length so a length mismatch alone reveals nothing more.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff = (a.len() ^ b.len()) as u8;
    let n = a.len().min(b.len());
    for i in 0..n {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// Decide whether a `rebase://callback` should be accepted.
///
/// `pending` is the consumed pending-login record (see `pending_login::take`).
/// A callback is rejected when there is no pending login (a stray/CSRF callback
/// or one that expired), when a supplied `state` doesn't match the pending one,
/// or when the token itself is malformed. `state_param` is `None` until the
/// control plane echoes `state` back — until then a pending login is all we can
/// require, which still blocks callbacks the user never initiated. Returns the
/// audit reason string on rejection.
fn validate_callback(
    token: &str,
    state_param: Option<&str>,
    pending: Option<rebase_core::pending_login::PendingLogin>,
) -> Result<(), &'static str> {
    let pending = pending.ok_or("no-pending")?;
    if let Some(state) = state_param {
        if !constant_time_eq(state.as_bytes(), pending.state.as_bytes()) {
            return Err("state-mismatch");
        }
    }
    validate_deeplink_token(token).map_err(|_| "bad-token")?;
    Ok(())
}

/// Handle an inbound `rebase://callback?token=…` deep link: validate against the
/// pending-login record + store the token and tell the webview to re-check auth
/// (or show an error). Every outcome is recorded in the auth audit log; a
/// rejection is a likely CSRF attempt worth surfacing.
fn handle_deep_link(app: &tauri::AppHandle, raw: &str) {
    let Ok(parsed) = url::Url::parse(raw) else {
        rebase_core::pending_login::audit("login-rejected", Some("bad-link"));
        let _ = app.emit("auth://error", "invalid sign-in link");
        return;
    };
    let token = parsed
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    let state_param = parsed
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned());

    // Consume the pending login (reads and deletes it) regardless of outcome.
    let pending = rebase_core::pending_login::take();
    if let Err(reason) = validate_callback(&token, state_param.as_deref(), pending) {
        eprintln!("rejecting deep-link callback: {reason}");
        rebase_core::pending_login::audit("login-rejected", Some(reason));
        let _ = app.emit("auth://error", format!("sign-in failed: {reason}"));
        return;
    }

    if let Err(e) = tokens::store(&Credential::Token { token: token.trim().to_string() }) {
        eprintln!("failed to store token from deep link: {e}");
        rebase_core::pending_login::audit("login-rejected", Some("store-failed"));
        let _ = app.emit("auth://error", "failed to save sign-in token");
        return;
    }
    rebase_core::pending_login::audit("login-completed", None);
    let _ = app.emit("auth://updated", ());
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // rustls needs a process-wide crypto provider before any TLS handshake.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        // single-instance must be registered first; on Windows/Linux a second
        // launch carrying the rebase:// URL forwards it here.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            for arg in argv {
                if arg.starts_with("rebase://") {
                    handle_deep_link(app, &arg);
                }
            }
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let oidc = AppConfig::load().ok().and_then(|c| c.oidc);
            app.manage(Arc::new(Auth::new(oidc)));
            app.manage(Arc::new(Transport::new()));
            app.manage(Arc::new(crucible::ChatCancels::default()));

            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Runtime registration (needed for dev / Linux).
                let _ = app.deep_link().register("rebase");
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        handle_deep_link(&handle, url.as_str());
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_control_planes,
            auth_status,
            login,
            set_credentials,
            logout,
            connect,
            disconnect,
            emit,
            search_code,
            crucible::crucible_local_index_dir,
            crucible::crucible_index_exists,
            crucible::crucible_extract_index,
            crucible::crucible_chat,
            crucible::crucible_chat_cancel,
            ollama::ollama_model_info,
            cache::cache_get,
            cache::cache_set,
            cache::cache_invalidate,
            cache::cache_invalidate_namespace,
            crucible::exec_allowlist_get,
            crucible::exec_allowlist_set,
            crucible::exec_allowlist_add,
            crucible::transcript_list,
            crucible::transcript_load_conversation,
            crucible::transcript_append_to,
            crucible::transcript_save_meta
        ])
        .run(tauri::generate_context!())
        .expect("error while running rebase");
}

#[cfg(test)]
mod tests {
    use super::{constant_time_eq, validate_callback, validate_deeplink_token};
    use rebase_core::pending_login::PendingLogin;

    fn pending(state: &str) -> PendingLogin {
        PendingLogin {
            state: state.into(),
            created_at: 0,
        }
    }

    #[test]
    fn callback_rejected_without_pending_login() {
        assert_eq!(
            validate_callback("good-token", None, None),
            Err("no-pending")
        );
    }

    #[test]
    fn callback_accepted_with_pending_and_no_state_echo() {
        // Until the server echoes `state`, a pending login is enough.
        assert!(validate_callback("good-token", None, Some(pending("s1"))).is_ok());
    }

    #[test]
    fn callback_accepted_when_state_matches() {
        assert!(validate_callback("good-token", Some("s1"), Some(pending("s1"))).is_ok());
    }

    #[test]
    fn callback_rejected_on_state_mismatch() {
        assert_eq!(
            validate_callback("good-token", Some("evil"), Some(pending("s1"))),
            Err("state-mismatch")
        );
    }

    #[test]
    fn callback_rejected_on_bad_token() {
        assert_eq!(
            validate_callback("has space", Some("s1"), Some(pending("s1"))),
            Err("bad-token")
        );
    }

    #[test]
    fn constant_time_eq_matches_semantics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn accepts_opaque_and_jwt_tokens() {
        assert!(validate_deeplink_token("opaque-access-token-123").is_ok());
        assert!(validate_deeplink_token("aaa.bbb.ccc").is_ok());
    }

    #[test]
    fn rejects_empty_and_whitespace() {
        assert!(validate_deeplink_token("").is_err());
        assert!(validate_deeplink_token("   ").is_err());
        assert!(validate_deeplink_token("has space").is_err());
        assert!(validate_deeplink_token("line\nbreak").is_err());
    }

    #[test]
    fn rejects_malformed_jwt() {
        assert!(validate_deeplink_token("aaa.bbb").is_err()); // 2 segments
        assert!(validate_deeplink_token("aaa..ccc").is_err()); // empty segment
        assert!(validate_deeplink_token("aaa.bbb.ccc.ddd").is_err()); // 4 segments
    }
}
