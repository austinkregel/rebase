use anyhow::{anyhow, Context, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::SignatureScheme;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio_tungstenite::Connector;

use crate::config::{ConnectionMode, Profile};

/// Build the URL + TLS connector + headers for a profile.
///
/// Direct mode pins the agent's self-signed cert (no public CA) and attaches
/// the OIDC Bearer token; relay mode uses the system trust store. See
/// docs/DIRECT-MODE.md "Connection abstraction".
pub struct DialPlan {
    pub url: String,
    pub connector: Option<Connector>,
    pub bearer: Option<String>,
}

pub fn plan_for(profile: &Profile, bearer: Option<String>) -> Result<DialPlan> {
    match profile.mode {
        ConnectionMode::Direct => {
            let connector = match &profile.cert_sha256 {
                Some(pin) => {
                    let fingerprint = parse_fingerprint(pin)?;
                    let config = rustls::ClientConfig::builder()
                        .dangerous()
                        .with_custom_certificate_verifier(Arc::new(PinnedVerifier {
                            fingerprint,
                            provider: rustls::crypto::ring::default_provider(),
                        }))
                        .with_no_client_auth();
                    Some(Connector::Rustls(Arc::new(config)))
                }
                None => None, // fall back to native roots (real cert)
            };
            Ok(DialPlan {
                url: profile.ws_url.clone(),
                connector,
                bearer,
            })
        }
        ConnectionMode::Relay => Ok(DialPlan {
            url: profile.ws_url.clone(),
            connector: None,
            bearer,
        }),
    }
}

/// Build a direct (P2P) dial plan from raw values discovered via the control
/// plane's client_list — no synthetic `Profile` needed. When `cert_sha256` is
/// set the agent's self-signed leaf is pinned; otherwise (public CA) native
/// roots are used. Mirrors the `Direct` arm of `plan_for`.
///
/// Building block for the direct-connection transport swap; not yet wired into
/// the single-connection `connect` path.
#[allow(dead_code)]
pub fn direct_plan(ws_url: &str, cert_sha256: Option<&str>, bearer: Option<String>) -> Result<DialPlan> {
    let connector = match cert_sha256 {
        Some(pin) if !pin.trim().is_empty() => {
            let fingerprint = parse_fingerprint(pin)?;
            let config = rustls::ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(PinnedVerifier {
                    fingerprint,
                    provider: rustls::crypto::ring::default_provider(),
                }))
                .with_no_client_auth();
            Some(Connector::Rustls(Arc::new(config)))
        }
        _ => None, // public CA → native roots
    };
    Ok(DialPlan {
        url: ws_url.to_string(),
        connector,
        bearer,
    })
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

/// A rustls verifier that accepts exactly one self-signed leaf cert, matched by
/// its SHA-256 fingerprint. Signature checks delegate to the crypto provider so
/// the TLS session itself is still sound — we only override chain/PKI trust.
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
        // Building a pinned ClientConfig needs the process-wide crypto provider
        // (installed in run() in production); install it here too.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let pin = "a".repeat(64); // 32 bytes hex
        let plan = direct_plan("wss://100.64.0.5:7420/ws", Some(&pin), Some("tok".into())).unwrap();
        assert_eq!(plan.url, "wss://100.64.0.5:7420/ws");
        assert!(plan.connector.is_some(), "a pinned cert should produce a custom connector");
        assert_eq!(plan.bearer.as_deref(), Some("tok"));
    }

    #[test]
    fn direct_plan_uses_native_roots_without_pin() {
        let plan = direct_plan("wss://agent.kregel.host/ws", None, None).unwrap();
        assert!(plan.connector.is_none(), "no pin → native roots (no custom connector)");
        let plan2 = direct_plan("wss://agent.kregel.host/ws", Some("  "), None).unwrap();
        assert!(plan2.connector.is_none(), "blank pin → native roots");
    }

    #[test]
    fn direct_plan_rejects_malformed_fingerprint() {
        assert!(direct_plan("wss://x/ws", Some("not-hex-and-too-short"), None).is_err());
    }
}
