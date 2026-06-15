mod codesearch;
mod config;
mod connection;
mod crucible;
mod oidc;
mod tokens;
mod transport;

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager, State};

use config::{AppConfig, ControlPlane};
use oidc::Auth;
use tokens::Credential;
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
    let url = auth_login_url(&cp.url)?;
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
fn auth_login_url(ws_url: &str) -> Result<String, String> {
    let u = url::Url::parse(ws_url).map_err(|e| e.to_string())?;
    let scheme = if u.scheme() == "wss" { "https" } else { "http" };
    let host = u.host_str().ok_or("control plane url has no host")?;
    let origin = match u.port() {
        Some(port) => format!("{scheme}://{host}:{port}"),
        None => format!("{scheme}://{host}"),
    };
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("redirect", "rebase://callback")
        .finish();
    Ok(format!("{origin}/auth/app?{query}"))
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

/// Handle an inbound `rebase://callback?token=…` deep link: validate + store the
/// token and tell the webview to re-check auth (or show an error).
fn handle_deep_link(app: &tauri::AppHandle, raw: &str) {
    let Ok(parsed) = url::Url::parse(raw) else {
        let _ = app.emit("auth://error", "invalid sign-in link");
        return;
    };
    let token = parsed
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();

    if let Err(reason) = validate_deeplink_token(&token) {
        eprintln!("rejecting deep-link token: {reason}");
        let _ = app.emit("auth://error", format!("sign-in failed: {reason}"));
        return;
    }

    if let Err(e) = tokens::store(&Credential::Token { token: token.trim().to_string() }) {
        eprintln!("failed to store token from deep link: {e}");
        let _ = app.emit("auth://error", "failed to save sign-in token");
        return;
    }
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
        .setup(|app| {
            let oidc = AppConfig::load().ok().and_then(|c| c.oidc);
            app.manage(Arc::new(Auth::new(oidc)));
            app.manage(Arc::new(Transport::new()));

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
            crucible::exec_allowlist_get,
            crucible::exec_allowlist_set
        ])
        .run(tauri::generate_context!())
        .expect("error while running rebase");
}

#[cfg(test)]
mod tests {
    use super::validate_deeplink_token;

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
