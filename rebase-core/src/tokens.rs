use anyhow::{anyhow, Result};
use keyring::Entry;
use serde::{Deserialize, Serialize};

const SERVICE: &str = "host.kregel.rebase";
const ACCOUNT: &str = "credential";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Credential {
    Token {
        token: String,
    },
    Client {
        client_id: String,
        client_secret: String,
    },
}

fn entry() -> Result<Entry> {
    Entry::new(SERVICE, ACCOUNT).map_err(|e| anyhow!(e))
}

pub fn store(cred: &Credential) -> Result<()> {
    let json = serde_json::to_string(cred)?;
    entry()?.set_password(&json).map_err(|e| anyhow!(e))
}

pub fn load() -> Result<Option<Credential>> {
    match entry()?.get_password() {
        Ok(json) => Ok(Some(serde_json::from_str(&json)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow!(e)),
    }
}

pub fn clear() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow!(e)),
    }
}
