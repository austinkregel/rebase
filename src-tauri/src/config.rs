use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const DEFAULT_ISSUER: &str = "https://aut.hair";
const DEFAULT_CP_NAME: &str = "kratos";
const DEFAULT_CP_URL: &str = "wss://kratos.kregel.host:8443/ws/dashboard";

/// App configuration loaded from the OS config dir (config.toml).
/// The control plane is the backbone; servers are discovered from it at runtime
/// (the client_list), not configured here. See docs/CONNECTIONS.md.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub oidc: Option<OidcConfig>,
    /// Control planes the app can connect to. Usually exactly one.
    #[serde(default, alias = "controlPlanes")]
    pub control_planes: Vec<ControlPlane>,
}

/// OIDC issuer (used to validate/mint tokens). The auth token itself lives in
/// the OS keychain, obtained via CP-brokered browser sign-in.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OidcConfig {
    pub issuer: String,
    #[serde(default = "default_scopes")]
    pub scopes: Vec<String>,
}

fn default_scopes() -> Vec<String> {
    vec!["openid".into()]
}

/// A control plane the app connects to for auth, server discovery, and relay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlPlane {
    pub name: String,
    /// Dashboard WebSocket URL, e.g. wss://kratos.kregel.host:8443/ws/dashboard.
    pub url: String,
    /// Optional pinned SHA-256 of the CP's leaf cert. Normally unset — the CP
    /// uses a publicly-trusted cert validated against the system trust store.
    #[serde(default)]
    pub cert_sha256: Option<String>,
}

/// A dial plan target. Built in code (from a ControlPlane for relay, or from a
/// discovered agent's advertisement for Stage 2 P2P) — no longer configured.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub mode: ConnectionMode,
    pub ws_url: String,
    /// Pinned SHA-256 of a self-signed leaf cert (P2P/direct only). `AB:CD:..` or bare hex.
    #[serde(default)]
    pub cert_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionMode {
    Direct,
    Relay,
}

impl ControlPlane {
    /// The relay dial plan for connecting to this control plane.
    pub fn as_relay_profile(&self) -> Profile {
        Profile {
            name: self.name.clone(),
            mode: ConnectionMode::Relay,
            ws_url: self.url.clone(),
            cert_sha256: self.cert_sha256.clone(),
        }
    }
}

pub fn config_path() -> Result<PathBuf> {
    let dir = dirs::config_dir().ok_or_else(|| anyhow!("no config dir"))?;
    Ok(dir.join("rebase").join("config.toml"))
}

impl AppConfig {
    /// Load config. Falls back to a built-in default (the kratos control plane +
    /// aut.hair issuer) so a fresh install is connectable with no config file.
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        let mut cfg = if path.exists() {
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            toml::from_str::<AppConfig>(&text).context("parsing config.toml")?
        } else {
            AppConfig::default()
        };
        cfg.apply_defaults();
        Ok(cfg)
    }

    fn apply_defaults(&mut self) {
        if self.control_planes.is_empty() {
            self.control_planes.push(ControlPlane {
                name: DEFAULT_CP_NAME.into(),
                url: DEFAULT_CP_URL.into(),
                cert_sha256: None,
            });
        }
        if self.oidc.is_none() {
            self.oidc = Some(OidcConfig {
                issuer: DEFAULT_ISSUER.into(),
                scopes: default_scopes(),
            });
        }
    }

    pub fn control_plane(&self, name: &str) -> Option<&ControlPlane> {
        self.control_planes.iter().find(|c| c.name == name)
    }
}
