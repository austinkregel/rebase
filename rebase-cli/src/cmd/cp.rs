use anyhow::{bail, Result};
use clap::Subcommand;

use rebase_core::config::{AppConfig, ControlPlane};

#[derive(Subcommand)]
pub enum CpCmd {
    /// List configured control planes
    List,
    /// Add or update a control plane
    Add {
        /// Short name (e.g. "kratos")
        name: String,
        /// Dashboard WebSocket URL (e.g. wss://host:8443/ws/dashboard)
        url: String,
        /// Optional SHA-256 fingerprint of a self-signed leaf cert (hex, for pinning)
        #[arg(long)]
        cert_sha256: Option<String>,
    },
    /// Remove a control plane
    Remove {
        name: String,
    },
}

pub fn run(cmd: CpCmd) -> Result<()> {
    match cmd {
        CpCmd::List => list(),
        CpCmd::Add { name, url, cert_sha256 } => add(name, url, cert_sha256),
        CpCmd::Remove { name } => remove(name),
    }
}

fn list() -> Result<()> {
    let cfg = AppConfig::load()?;
    if cfg.control_planes.is_empty() {
        println!("no control planes configured");
        return Ok(());
    }
    for cp in &cfg.control_planes {
        let pin = cp
            .cert_sha256
            .as_deref()
            .map(|s| format!(" (pinned: {s})"))
            .unwrap_or_default();
        println!("{:<20} {}{}", cp.name, cp.url, pin);
    }
    Ok(())
}

fn add(name: String, url: String, cert_sha256: Option<String>) -> Result<()> {
    if !url.starts_with("ws://") && !url.starts_with("wss://") {
        bail!("url must be a WebSocket URL (ws:// or wss://)");
    }
    let mut cfg = AppConfig::load()?;
    let existed = cfg.control_planes.iter().any(|c| c.name == name);
    cfg.upsert_control_plane(ControlPlane { name: name.clone(), url, cert_sha256 });
    cfg.save()?;
    if existed {
        println!("updated control plane '{name}'");
    } else {
        println!("added control plane '{name}'");
    }
    Ok(())
}

fn remove(name: String) -> Result<()> {
    let mut cfg = AppConfig::load()?;
    if !cfg.remove_control_plane(&name) {
        bail!("no control plane named '{name}'");
    }
    cfg.save()?;
    println!("removed control plane '{name}'");
    Ok(())
}
