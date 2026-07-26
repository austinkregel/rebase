//! Ollama model metadata.
//!
//! Exists for one reason: knowing a model's real context window. Ollama's
//! `/api/chat` silently truncates to the *modelfile's* `num_ctx` — commonly 4096
//! — regardless of what the model supports, so any context budgeting we do is
//! fiction unless we discover the window and send `num_ctx` explicitly.

use serde::Serialize;

/// What the app needs to know about a model to budget a prompt for it.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// Usable context window in tokens, or `None` when `/api/show` didn't say.
    /// Callers pick their own conservative default rather than inheriting a
    /// wrong one from here.
    pub context_window: Option<u32>,
    /// True when the window came from an explicit modelfile `num_ctx` rather
    /// than the architecture's trained length.
    ///
    /// A pin is a deliberate operator choice about *this* machine, so callers
    /// should use `context_window` exactly as reported — not clamp it in either
    /// direction. Raising a pin wastes memory the operator said they don't have;
    /// lowering it truncates below what they asked for.
    pub pinned: bool,
    pub family: Option<String>,
    pub parameter_size: Option<String>,
}

/// Pull the trained context length out of `/api/show`'s `model_info` map.
///
/// The key is architecture-prefixed (`llama.context_length`,
/// `qwen2.context_length`, …), so resolve the architecture first and fall back
/// to any key with that suffix — new architectures ship faster than we can
/// enumerate them.
fn trained_context_length(model_info: &serde_json::Value) -> Option<u32> {
    let obj = model_info.as_object()?;
    if let Some(arch) = obj.get("general.architecture").and_then(|a| a.as_str()) {
        if let Some(n) = obj.get(&format!("{arch}.context_length")).and_then(|c| c.as_u64()) {
            return u32::try_from(n).ok();
        }
    }
    obj.iter()
        .find(|(k, _)| k.ends_with(".context_length"))
        .and_then(|(_, v)| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
}

/// `/api/show` returns `parameters` as a flat text blob, one `key value` per
/// line. An explicit `num_ctx` there is the operative ceiling: the server will
/// apply it whatever the model was trained for.
fn pinned_num_ctx(parameters: Option<&str>) -> Option<u32> {
    parameters?
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            match (parts.next(), parts.next()) {
                (Some("num_ctx"), Some(v)) => v.trim_matches('"').parse::<u32>().ok(),
                _ => None,
            }
        })
        .next_back()
}

/// Parse a `/api/show` response body. Split out from the request so the mapping
/// rules are testable without a live Ollama.
fn parse_show(body: &serde_json::Value) -> ModelInfo {
    let trained = body.get("model_info").and_then(trained_context_length);
    let pinned = pinned_num_ctx(body.get("parameters").and_then(|p| p.as_str()));

    // A pin wins over the trained length in both directions: it is what the
    // server will actually enforce for this model on this machine.
    let (context_window, was_pinned) = match (pinned, trained) {
        (Some(p), _) => (Some(p), true),
        (None, t) => (t, false),
    };

    ModelInfo {
        context_window,
        pinned: was_pinned,
        family: body
            .get("details")
            .and_then(|d| d.get("family"))
            .and_then(|f| f.as_str())
            .map(str::to_string),
        parameter_size: body
            .get("details")
            .and_then(|d| d.get("parameter_size"))
            .and_then(|p| p.as_str())
            .map(str::to_string),
    }
}

/// Ask Ollama about a model. Errors are the caller's cue to fall back to a
/// conservative window rather than to fail the chat.
#[tauri::command]
pub async fn ollama_model_info(ollama: String, model: String) -> Result<ModelInfo, String> {
    let url = format!("{}/api/show", ollama.trim_end_matches('/'));
    // This sits on the interactive path — it runs before the first token of every
    // turn — so it must fail fast. A blackholed host would otherwise hang the
    // whole turn before any UI feedback, and there is nothing to cancel yet.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|e| format!("POST {url} (is Ollama running?): {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let detail = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama show {status}: {}", detail.trim()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parse_show(&body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn show(json: serde_json::Value) -> ModelInfo {
        parse_show(&json)
    }

    #[test]
    fn reads_the_architecture_prefixed_context_length() {
        let info = show(serde_json::json!({
            "model_info": {
                "general.architecture": "qwen2",
                "qwen2.context_length": 32768,
                "qwen2.embedding_length": 3584,
            },
            "details": { "family": "qwen2", "parameter_size": "7.6B" },
        }));
        assert_eq!(info.context_window, Some(32768));
        assert!(!info.pinned);
        assert_eq!(info.family.as_deref(), Some("qwen2"));
        assert_eq!(info.parameter_size.as_deref(), Some("7.6B"));
    }

    #[test]
    fn falls_back_to_any_context_length_key_for_unknown_architectures() {
        // A brand-new architecture we've never heard of still resolves.
        let info = show(serde_json::json!({
            "model_info": {
                "general.architecture": "somethingnew",
                "somethingnew.context_length": 262144,
            },
        }));
        assert_eq!(info.context_window, Some(262144));
    }

    #[test]
    fn a_pinned_num_ctx_wins_over_the_trained_length() {
        // This is the case that makes budgeting honest: the model supports 128k
        // but the modelfile pins 8k, and the server will enforce 8k.
        let info = show(serde_json::json!({
            "model_info": { "general.architecture": "llama", "llama.context_length": 131072 },
            "parameters": "stop \"<|eot_id|>\"\nnum_ctx 8192\ntemperature 0.7",
        }));
        assert_eq!(info.context_window, Some(8192));
        assert!(info.pinned);
    }

    #[test]
    fn missing_metadata_yields_none_rather_than_a_guess() {
        assert_eq!(show(serde_json::json!({})), ModelInfo::default());
        assert_eq!(
            show(serde_json::json!({ "model_info": { "general.architecture": "llama" } })).context_window,
            None,
        );
    }

    #[test]
    fn ignores_parameter_lines_that_are_not_num_ctx() {
        assert_eq!(pinned_num_ctx(Some("temperature 0.7\nstop \"x\"")), None);
        assert_eq!(pinned_num_ctx(Some("num_ctx notanumber")), None);
        assert_eq!(pinned_num_ctx(None), None);
        // Ollama repeats keys for multi-valued params; the last one is live.
        assert_eq!(pinned_num_ctx(Some("num_ctx 2048\nnum_ctx 4096")), Some(4096));
    }
}
