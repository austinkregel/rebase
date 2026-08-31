use anyhow::{anyhow, Context, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::SignatureScheme;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_tungstenite::Connector;

use crate::config::{ConnectionMode, Profile};

pub struct DialPlan {
    pub url: String,
    pub connector: Option<Connector>,
    pub bearer: Option<String>,
}

pub fn plan_for(profile: &Profile, bearer: Option<String>) -> Result<DialPlan> {
    match profile.mode {
        ConnectionMode::Direct => Ok(DialPlan {
            url: profile.ws_url.clone(),
            connector: pinned_connector(profile.cert_sha256.as_deref())?,
            bearer,
        }),
        // Relay mode also honors a configured pin: `as_relay_profile` copies
        // `cert_sha256` from the control-plane entry, so a self-signed control
        // plane reached over the relay leg is pinned exactly like a direct one.
        ConnectionMode::Relay => Ok(DialPlan {
            url: profile.ws_url.clone(),
            connector: pinned_connector(profile.cert_sha256.as_deref())?,
            bearer,
        }),
    }
}

#[allow(dead_code)]
pub fn direct_plan(ws_url: &str, cert_sha256: Option<&str>, bearer: Option<String>) -> Result<DialPlan> {
    Ok(DialPlan {
        url: ws_url.to_string(),
        connector: pinned_connector(cert_sha256)?,
        bearer,
    })
}

/// Build a rustls `Connector` that pins the server's leaf certificate to the
/// given SHA-256 fingerprint (hex). Returns `Ok(None)` when no pin is set (or it
/// is blank), in which case the caller falls back to the platform's native roots.
///
/// NOTE: the resulting `PinnedVerifier` checks ONLY the leaf certificate's
/// SHA-256 and deliberately ignores hostname and expiry. That is correct for a
/// deliberately pinned self-signed cert (see docs/DIRECT-MODE.md) and must not
/// be reused as a general-purpose certificate verifier.
fn pinned_connector(cert_sha256: Option<&str>) -> Result<Option<Connector>> {
    match cert_sha256 {
        Some(pin) if !pin.trim().is_empty() => {
            let fingerprint = parse_fingerprint(pin)?;
            let config = rustls::ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(PinnedVerifier {
                    fingerprint,
                    provider: rustls::crypto::ring::default_provider(),
                }))
                .with_no_client_auth();
            Ok(Some(Connector::Rustls(Arc::new(config))))
        }
        _ => Ok(None),
    }
}

fn parse_fingerprint(pin: &str) -> Result<[u8; 32]> {
    let cleaned: String = pin.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let bytes = hex::decode(&cleaned).context("cert_sha256 is not valid hex")?;
    if bytes.len() != 32 {
        return Err(anyhow!("cert_sha256 must be 32 bytes (SHA-256), got {}", bytes.len()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

#[derive(Debug)]
struct PinnedVerifier {
    fingerprint: [u8; 32],
    provider: rustls::crypto::CryptoProvider,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let mut hasher = Sha256::new();
        hasher.update(end_entity.as_ref());
        let digest = hasher.finalize();
        if digest.as_slice() == self.fingerprint {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("pinned cert fingerprint mismatch".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_plan_pins_when_fingerprint_present() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let pin = "a".repeat(64);
        let plan = direct_plan("wss://100.64.0.5:7420/ws", Some(&pin), Some("tok".into())).unwrap();
        assert_eq!(plan.url, "wss://100.64.0.5:7420/ws");
        assert!(plan.connector.is_some());
        assert_eq!(plan.bearer.as_deref(), Some("tok"));
    }

    #[test]
    fn direct_plan_uses_native_roots_without_pin() {
        let plan = direct_plan("wss://agent.kregel.host/ws", None, None).unwrap();
        assert!(plan.connector.is_none());
        let plan2 = direct_plan("wss://agent.kregel.host/ws", Some("  "), None).unwrap();
        assert!(plan2.connector.is_none());
    }

    #[test]
    fn direct_plan_rejects_malformed_fingerprint() {
        assert!(direct_plan("wss://x/ws", Some("not-hex-and-too-short"), None).is_err());
    }

    #[test]
    fn relay_plan_pins_when_fingerprint_present() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let profile = Profile {
            name: "cp".into(),
            mode: ConnectionMode::Relay,
            ws_url: "wss://kratos.kregel.host:8443/ws/dashboard".into(),
            cert_sha256: Some("a".repeat(64)),
        };
        let plan = plan_for(&profile, Some("tok".into())).unwrap();
        assert!(plan.connector.is_some(), "relay pin must produce a connector");
        assert_eq!(plan.bearer.as_deref(), Some("tok"));
    }

    #[test]
    fn relay_plan_uses_native_roots_without_pin() {
        let profile = Profile {
            name: "cp".into(),
            mode: ConnectionMode::Relay,
            ws_url: "wss://kratos.kregel.host:8443/ws/dashboard".into(),
            cert_sha256: None,
        };
        let plan = plan_for(&profile, None).unwrap();
        assert!(plan.connector.is_none(), "no pin means native roots");
    }
}
