use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const DEFAULT_ISSUER: &str = "https://aut.hair";
const DEFAULT_CP_NAME: &str = "kratos";
const DEFAULT_CP_URL: &str = "wss://kratos.kregel.host:8443/ws/dashboard";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub oidc: Option<OidcConfig>,
    #[serde(default, alias = "controlPlanes")]
    pub control_planes: Vec<ControlPlane>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OidcConfig {
    pub issuer: String,
    #[serde(default = "default_scopes")]
    pub scopes: Vec<String>,
}

fn default_scopes() -> Vec<String> {
    vec!["openid".into()]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlPlane {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub cert_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub mode: ConnectionMode,
    pub ws_url: String,
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
    pub fn as_relay_profile(&self) -> Profile {
        Profile {
            name: self.name.clone(),
            mode: ConnectionMode::Relay,
            ws_url: self.url.clone(),
            cert_sha256: self.cert_sha256.clone(),
        }
    }

    /// Base HTTPS URL for the control plane's REST API.
    /// e.g. `wss://host:8443/ws/dashboard` → `https://host:8443`
    pub fn http_base(&self) -> Result<String> {
        let u = url::Url::parse(&self.url).context("parsing control plane URL")?;
        let scheme = if u.scheme() == "wss" { "https" } else { "http" };
        let host = u.host_str().ok_or_else(|| anyhow!("control plane URL has no host"))?;
        Ok(match u.port() {
            Some(port) => format!("{scheme}://{host}:{port}"),
            None => format!("{scheme}://{host}"),
        })
    }

    /// Browser sign-in URL for the GUI / CLI `auth login` flow. `state` is a
    /// caller-generated CSRF token echoed back on the `rebase://callback`
    /// redirect (once the control plane preserves it) and matched by the
    /// deep-link handler against the pending-login record.
    pub fn auth_login_url(&self, state: &str) -> Result<String> {
        let base = self.http_base()?;
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("redirect", "rebase://callback")
            .append_pair("state", state)
            .finish();
        Ok(format!("{base}/auth/app?{query}"))
    }
}

pub fn config_path() -> Result<PathBuf> {
    let dir = dirs::config_dir().ok_or_else(|| anyhow!("no config dir"))?;
    Ok(dir.join("rebase").join("config.toml"))
}

impl AppConfig {
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

    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        // Serialize a copy without the applied defaults so we don't bloat the
        // file with values the user never explicitly set.
        let text = toml::to_string_pretty(self).context("serializing config")?;
        std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
        Ok(())
    }

    /// Upsert a control plane by name (replaces if the name already exists).
    pub fn upsert_control_plane(&mut self, cp: ControlPlane) {
        if let Some(existing) = self.control_planes.iter_mut().find(|c| c.name == cp.name) {
            *existing = cp;
        } else {
            self.control_planes.push(cp);
        }
    }

    /// Remove a control plane by name. Returns true if it was present.
    pub fn remove_control_plane(&mut self, name: &str) -> bool {
        let before = self.control_planes.len();
        self.control_planes.retain(|c| c.name != name);
        self.control_planes.len() < before
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
