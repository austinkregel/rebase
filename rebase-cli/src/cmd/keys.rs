use anyhow::{anyhow, bail, Context, Result};
use clap::Subcommand;
use serde::Deserialize;

use rebase_core::{config::AppConfig, oidc::Auth};

#[derive(Subcommand)]
pub enum KeysCmd {
    /// Sync a GitHub user's public SSH keys to an agent's authorized_keys file
    Sync {
        /// GitHub username (e.g. "austinkregel") — keys are fetched from github.com/{user}.keys
        github_user: String,
        /// Agent client ID to target. If omitted and exactly one agent is online, it is used automatically.
        #[arg(long)]
        agent: Option<String>,
        /// Control plane to use (defaults to the first configured one)
        #[arg(long)]
        control_plane: Option<String>,
    },
}

pub async fn run(cmd: KeysCmd) -> Result<()> {
    match cmd {
        KeysCmd::Sync { github_user, agent, control_plane } => {
            sync(github_user, agent, control_plane).await
        }
    }
}

/// Status response from GET /api/status on the control plane.
#[derive(Debug, Deserialize)]
struct CpStatus {
    #[serde(rename = "clientIds", default)]
    client_ids: Vec<String>,
}

async fn sync(github_user: String, agent: Option<String>, cp_name: Option<String>) -> Result<()> {
    let cfg = AppConfig::load()?;

    let cp = match cp_name {
        Some(ref name) => cfg
            .control_plane(name)
            .ok_or_else(|| anyhow!("unknown control plane '{name}'"))?,
        None => cfg
            .control_planes
            .first()
            .ok_or_else(|| anyhow!("no control planes configured"))?,
    };

    let base = cp.http_base()?;

    // Get a bearer token.
    let auth = Auth::new(cfg.oidc);
    let bearer = auth
        .bearer()
        .await?
        .ok_or_else(|| anyhow!("not authenticated — run `rebase auth login` or `rebase auth credentials`"))?;

    let http = reqwest::Client::new();

    // Resolve the target agent.
    let client_id = match agent {
        Some(id) => id,
        None => {
            let status: CpStatus = http
                .get(format!("{base}/api/status"))
                .bearer_auth(&bearer)
                .send()
                .await
                .context("fetching agent list from control plane")?
                .error_for_status()
                .context("control plane returned an error")?
                .json()
                .await
                .context("parsing control plane status")?;

            match status.client_ids.len() {
                0 => bail!("no agents are currently connected to the control plane"),
                1 => status.client_ids.into_iter().next().unwrap(),
                _ => {
                    eprintln!("multiple agents connected — specify one with --agent:");
                    for id in &status.client_ids {
                        eprintln!("  {id}");
                    }
                    bail!("use --agent <client-id> to select a target");
                }
            }
        }
    };

    println!("syncing github.com/{github_user}.keys → agent {client_id}");

    let resp = http
        .post(format!("{base}/api/client/{client_id}/keys/resync"))
        .bearer_auth(&bearer)
        .json(&serde_json::json!({ "githubUser": github_user }))
        .send()
        .await
        .context("sending keys resync request")?
        .error_for_status()
        .context("control plane rejected the request")?
        .json::<serde_json::Value>()
        .await
        .context("parsing response")?;

    println!("dispatched — agent will fetch and apply keys");
    if let Some(status) = resp.get("status") {
        println!("status: {status}");
    }
    Ok(())
}
