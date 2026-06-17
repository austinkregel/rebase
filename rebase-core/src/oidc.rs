use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::config::OidcConfig;
use crate::tokens::{self, Credential};

#[derive(Debug, Clone, Deserialize)]
struct Discovery {
    token_endpoint: String,
    #[serde(default)]
    #[allow(dead_code)]
    machine_info_endpoint: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct MachineInfo {
    pub client_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub scopes: Vec<String>,
}

struct CachedToken {
    token: String,
    expires_at: Instant,
}

pub struct Auth {
    issuer: Option<String>,
    scopes: Vec<String>,
    http: reqwest::Client,
    cached: Mutex<Option<CachedToken>>,
    discovery: Mutex<Option<Discovery>>,
}

impl Auth {
    pub fn new(cfg: Option<OidcConfig>) -> Self {
        let (issuer, scopes) = match cfg {
            Some(c) => (Some(c.issuer), c.scopes),
            None => (None, vec!["openid".into()]),
        };
        Self {
            issuer,
            scopes,
            http: reqwest::Client::new(),
            cached: Mutex::new(None),
            discovery: Mutex::new(None),
        }
    }

    pub async fn bearer(&self) -> Result<Option<String>> {
        let Some(cred) = tokens::load()? else {
            return Ok(None);
        };
        match cred {
            Credential::Token { token } => Ok(Some(token)),
            Credential::Client { client_id, client_secret } => {
                {
                    let guard = self.cached.lock().await;
                    if let Some(c) = guard.as_ref() {
                        if c.expires_at > Instant::now() + Duration::from_secs(60) {
                            return Ok(Some(c.token.clone()));
                        }
                    }
                }
                let token = self.mint(&client_id, &client_secret).await?;
                Ok(Some(token))
            }
        }
    }

    async fn mint(&self, client_id: &str, client_secret: &str) -> Result<String> {
        let token_endpoint = self.discovery().await?.token_endpoint;
        let resp = self
            .http
            .post(&token_endpoint)
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", client_id),
                ("client_secret", client_secret),
                ("scope", &self.scopes.join(" ")),
            ])
            .send()
            .await
            .context("token request failed")?
            .error_for_status()
            .context("token endpoint rejected client_credentials")?
            .json::<TokenResponse>()
            .await
            .context("parsing token response")?;

        let ttl = resp.expires_in.unwrap_or(3600).saturating_sub(60).max(30);
        let mut guard = self.cached.lock().await;
        *guard = Some(CachedToken {
            token: resp.access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(ttl),
        });
        Ok(resp.access_token)
    }

    #[allow(dead_code)]
    pub async fn machine_info(&self, token: &str) -> Result<Option<MachineInfo>> {
        let url = self
            .discovery()
            .await?
            .machine_info_endpoint
            .ok_or_else(|| anyhow!("issuer advertises no machine_info_endpoint"))?;
        let resp = self.http.get(&url).bearer_auth(token).send().await?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Ok(None);
        }
        let info = resp
            .error_for_status()
            .context("machine-info request failed")?
            .json::<MachineInfo>()
            .await
            .context("parsing machine-info")?;
        Ok(Some(info))
    }

    async fn discovery(&self) -> Result<Discovery> {
        {
            let guard = self.discovery.lock().await;
            if let Some(d) = guard.as_ref() {
                return Ok(d.clone());
            }
        }
        let issuer = self
            .issuer
            .as_ref()
            .ok_or_else(|| anyhow!("no OIDC issuer configured (set [oidc] in config.toml)"))?;
        let url = format!("{}/.well-known/openid-configuration", issuer.trim_end_matches('/'));
        let discovery = self
            .http
            .get(&url)
            .send()
            .await
            .context("fetching discovery document")?
            .error_for_status()
            .context("discovery endpoint error")?
            .json::<Discovery>()
            .await
            .context("parsing discovery document")?;
        let mut guard = self.discovery.lock().await;
        *guard = Some(discovery.clone());
        Ok(discovery)
    }
}
