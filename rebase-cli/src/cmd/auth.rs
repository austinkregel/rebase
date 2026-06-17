use anyhow::{bail, Result};
use clap::Subcommand;

use rebase_core::{
    config::AppConfig,
    oidc::Auth,
    tokens::{self, Credential},
};

#[derive(Subcommand)]
pub enum AuthCmd {
    /// Show whether credentials are stored and whether they work
    Status,
    /// Open the browser to sign in via the control plane (token lands in the Rebase app or keychain)
    Login {
        /// Control plane to sign in with (defaults to the first configured one)
        #[arg(long)]
        control_plane: Option<String>,
    },
    /// Remove stored credentials
    Logout,
    /// Store a static token or machine client credentials (for CI / headless use)
    Credentials {
        #[arg(long, help = "Static access token")]
        token: Option<String>,
        #[arg(long, requires = "client_secret", help = "OAuth2 client ID")]
        client_id: Option<String>,
        #[arg(long, requires = "client_id", help = "OAuth2 client secret")]
        client_secret: Option<String>,
    },
}

pub async fn run(cmd: AuthCmd) -> Result<()> {
    match cmd {
        AuthCmd::Status => status().await,
        AuthCmd::Login { control_plane } => login(control_plane),
        AuthCmd::Logout => logout(),
        AuthCmd::Credentials { token, client_id, client_secret } => {
            credentials(token, client_id, client_secret)
        }
    }
}

async fn status() -> Result<()> {
    let cred = tokens::load()?;
    match cred {
        None => {
            println!("not authenticated");
            println!("hint: run `rebase auth login` or `rebase auth credentials --token <tok>`");
        }
        Some(Credential::Token { .. }) => {
            println!("authenticated (static token)");
        }
        Some(Credential::Client { ref client_id, .. }) => {
            println!("authenticated (client credentials, client_id={client_id})");
            // Try minting a token to verify the credentials are still valid.
            let cfg = AppConfig::load()?;
            let auth = Auth::new(cfg.oidc);
            match auth.bearer().await {
                Ok(Some(_)) => println!("token mint: ok"),
                Ok(None) => println!("token mint: no credential (unexpected)"),
                Err(e) => println!("token mint: failed — {e:#}"),
            }
        }
    }
    Ok(())
}

fn login(control_plane: Option<String>) -> Result<()> {
    let cfg = AppConfig::load()?;
    let cp = match control_plane {
        Some(ref name) => cfg
            .control_plane(name)
            .ok_or_else(|| anyhow::anyhow!("unknown control plane '{name}'"))?,
        None => cfg
            .control_planes
            .first()
            .ok_or_else(|| anyhow::anyhow!("no control planes configured"))?,
    };
    let url = cp.auth_login_url()?;
    println!("Opening {url}");
    println!("Complete sign-in in your browser. The token is stored in the OS keychain and");
    println!("shared between the Rebase app and this CLI.");
    open::that(&url).map_err(|e| anyhow::anyhow!("failed to open browser: {e}"))?;
    Ok(())
}

fn logout() -> Result<()> {
    tokens::clear()?;
    println!("signed out");
    Ok(())
}

fn credentials(
    token: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<()> {
    let cred = match (token, client_id, client_secret) {
        (Some(t), _, _) if !t.trim().is_empty() => Credential::Token { token: t.trim().into() },
        (_, Some(id), Some(secret)) => Credential::Client {
            client_id: id,
            client_secret: secret,
        },
        _ => bail!("provide --token, or both --client-id and --client-secret"),
    };
    tokens::store(&cred)?;
    println!("credentials stored");
    Ok(())
}
