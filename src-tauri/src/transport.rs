use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tauri::{AppHandle, Emitter};

use rebase_core::connection::DialPlan;

/// Tauri event names bridged to the webview. See docs/DIRECT-MODE.md "IPC contract".
pub const EV_FRAME: &str = "cp://frame";
pub const EV_STATUS: &str = "cp://status";

#[derive(Clone, Serialize)]
struct Frame {
    event: String,
    data: Value,
}

#[derive(Clone, Serialize)]
struct StatusEvent {
    status: &'static str,
}

/// Aborts the wrapped task when dropped, so replacing/closing a connection
/// tears its pump down.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Owns the single active connection. The webview drives it via Tauri commands;
/// the pump forwards inbound protocol frames out as `cp://frame` events.
#[derive(Default)]
pub struct Transport {
    inner: Mutex<Option<Handle>>,
}

struct Handle {
    /// Outbound frames queued by `emit`.
    tx: mpsc::UnboundedSender<Message>,
    _task: AbortOnDrop,
}

impl Transport {
    pub fn new() -> Self {
        Self::default()
    }

    /// Connect using a prepared dial plan. Replaces any existing connection.
    pub async fn connect(&self, app: AppHandle, plan: DialPlan) -> Result<()> {
        self.disconnect().await;
        emit_status(&app, "connecting");

        let mut request = plan.url.as_str().into_client_request()?;
        if let Some(token) = &plan.bearer {
            request.headers_mut().insert(
                "Authorization",
                format!("Bearer {token}")
                    .parse()
                    .map_err(|_| anyhow!("bad bearer token"))?,
            );
        }

        let dial =
            tokio_tungstenite::connect_async_tls_with_config(request, None, false, plan.connector)
                .await;
        let (ws, _resp) = match dial {
            Ok(pair) => pair,
            Err(e) => {
                emit_status(&app, "closed"); // let the UI fall back to the chooser
                return Err(e.into());
            }
        };

        emit_status(&app, "open");

        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let pong_tx = tx.clone();
        let app_for_task = app.clone();

        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    outbound = rx.recv() => {
                        match outbound {
                            Some(msg) => {
                                if sink.send(msg).await.is_err() {
                                    break;
                                }
                            }
                            None => break, // all senders dropped
                        }
                    }
                    inbound = stream.next() => {
                        match inbound {
                            Some(Ok(Message::Text(text))) => {
                                forward_text(&app_for_task, &text, &pong_tx);
                            }
                            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                            _ => {}
                        }
                    }
                }
            }
            emit_status(&app_for_task, "closed");
        });

        let mut guard = self.inner.lock().await;
        *guard = Some(Handle {
            tx,
            _task: AbortOnDrop(task),
        });
        Ok(())
    }

    pub async fn disconnect(&self) {
        let mut guard = self.inner.lock().await;
        *guard = None; // drops Handle → aborts pump task
    }

    /// Queue a protocol frame for sending. Returns false if not connected.
    pub async fn emit(&self, event: &str, data: Value) -> bool {
        let guard = self.inner.lock().await;
        let Some(handle) = guard.as_ref() else {
            return false;
        };
        let frame = json!({ "event": event, "data": data });
        handle.tx.send(Message::Text(frame.to_string())).is_ok()
    }
}

/// Decode one inbound `{event,data}` frame and forward it to the webview.
/// Answer the control-plane keepalive ping in Rust so the connection survives
/// independent of the webview.
fn forward_text(app: &AppHandle, text: &str, pong_tx: &mpsc::UnboundedSender<Message>) {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return;
    };
    let event = value.get("event").and_then(Value::as_str).unwrap_or_default();
    if event.is_empty() {
        return;
    }
    let data = value.get("data").cloned().unwrap_or_else(|| json!({}));

    if event == "ping" {
        let pong = json!({ "event": "pong", "data": { "ts": 0 } });
        let _ = pong_tx.send(Message::Text(pong.to_string()));
        return;
    }

    let _ = app.emit(
        EV_FRAME,
        Frame {
            event: event.to_string(),
            data,
        },
    );
}

fn emit_status(app: &AppHandle, status: &'static str) {
    let _ = app.emit(EV_STATUS, StatusEvent { status });
}
