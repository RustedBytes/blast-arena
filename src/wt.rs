//! WebTransport (HTTP/3 over QUIC, UDP): the low-latency transport, with
//! the WebSocket at `/ws` as the fallback for browsers without it.
//!
//! A session at `/wt?arena=N` uses one bidirectional stream for everything
//! reliable, in both directions, as frames of a 4-byte little-endian length
//! then the message. Snapshots go as datagrams when they fit (a lost one is
//! simply replaced by the next), and through the stream when they don't.
//!
//! Certificates: with `--wt-cert`/`--wt-key` the endpoint uses those PEM
//! files and reloads them when they change. Without, it makes a self-signed
//! certificate valid for 13 days, renews it every 6, and `/api/transport`
//! hands browsers its SHA-256 hash (`serverCertificateHashes`); browsers
//! that can't use the hash fall back to the WebSocket.

use std::fmt::Write as _;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use bytes::{BufMut, Bytes, BytesMut};
use serde::Serialize;
use tracing::Instrument;
use wtransport::endpoint::IncomingSession;
use wtransport::error::{SendDatagramError, StreamReadExactError};
use wtransport::{Connection, Endpoint, Identity, RecvStream, SendStream, ServerConfig};

use crate::net::{self, AppState, Inbound, Outbound};

/// Largest client message accepted (the WebSocket has the same limit).
const MAX_CLIENT_MSG: usize = 4096;
/// Self-signed certificates: browsers accept a hash only for certificates
/// valid at most 14 days.
const SELF_SIGNED_DAYS: u32 = 13;
#[allow(clippy::duration_suboptimal_units, reason = "Duration::from_hours needs Rust 1.91")]
const SELF_SIGNED_RENEW: Duration = Duration::from_secs(6 * 24 * 3600);
/// How often certificate files are checked for a renewal.
const CERT_FILE_CHECK: Duration = Duration::from_secs(3600);
/// Time the client gets to open its stream after the session is accepted.
const STREAM_TIMEOUT: Duration = Duration::from_secs(10);

/// What `/api/transport` tells browsers.
#[derive(Clone, Serialize)]
pub struct WtInfo {
    /// UDP port to connect to.
    pub port: u16,
    /// Hex SHA-256 hashes of a self-signed certificate (empty with a real one).
    pub hashes: Vec<String>,
}

/// Endpoint settings from the command line.
pub struct Settings {
    /// UDP port to listen on.
    pub port: u16,
    /// Port browsers connect to, if a proxy or port mapping changes it.
    pub public_port: Option<u16>,
    /// PEM certificate chain and private key; self-signed when absent.
    pub cert: Option<(PathBuf, PathBuf)>,
    /// Extra names for a self-signed certificate (the public host).
    pub names: Vec<String>,
}

/// Where the certificate comes from.
enum Certs {
    Files { cert: PathBuf, key: PathBuf, modified: Option<SystemTime> },
    SelfSigned { names: Vec<String> },
}

impl Certs {
    /// A fresh identity and the hashes browsers need for it.
    async fn load(&mut self) -> Result<(Identity, Vec<String>), String> {
        match self {
            Certs::Files { cert, key, modified } => {
                *modified = mtime(cert);
                let identity = Identity::load_pemfiles(&*cert, &*key).await.map_err(|e| format!("can't load {}: {e}", cert.display()))?;
                Ok((identity, Vec::new()))
            }
            Certs::SelfSigned { names } => {
                let identity = Identity::self_signed_builder()
                    .subject_alt_names(names.iter())
                    .from_now_utc()
                    .validity_days(SELF_SIGNED_DAYS)
                    .build()
                    .map_err(|e| format!("can't make a certificate: {e}"))?;
                let hashes = identity.certificate_chain().as_slice().iter().take(1).map(|c| hex(c.hash().as_ref())).collect();
                Ok((identity, hashes))
            }
        }
    }

    /// How long until the next check for a new certificate.
    fn check_every(&self) -> Duration {
        match self {
            Certs::Files { .. } => CERT_FILE_CHECK,
            Certs::SelfSigned { .. } => SELF_SIGNED_RENEW,
        }
    }

    /// Whether the certificate should be reloaded now.
    fn stale(&self) -> bool {
        match self {
            Certs::Files { cert, modified, .. } => mtime(cert) != *modified,
            Certs::SelfSigned { .. } => true,
        }
    }
}

fn mtime(path: &PathBuf) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

fn server_config(addr: SocketAddr, identity: Identity) -> ServerConfig {
    let builder = if addr.is_ipv6() {
        ServerConfig::builder().with_bind_default(addr.port())
    } else {
        ServerConfig::builder().with_bind_address(addr)
    };
    builder
        .with_identity(identity)
        .keep_alive_interval(Some(Duration::from_secs(3)))
        .max_idle_timeout(Some(Duration::from_secs(15)))
        .expect("15 s is a valid idle timeout")
        .build()
}

/// Starts the endpoint and returns what browsers need to reach it, or
/// `None` (logged) if it can't start; the game then runs on `WebSockets` only.
pub async fn start(settings: Settings, state: AppState) -> Option<WtInfo> {
    let mut certs = if let Some((cert, key)) = settings.cert {
        Certs::Files { cert, key, modified: None }
    } else {
        let mut names = vec!["localhost".to_owned(), "127.0.0.1".to_owned(), "::1".to_owned()];
        names.extend(settings.names);
        Certs::SelfSigned { names }
    };
    let (identity, hashes) = match certs.load().await {
        Ok(v) => v,
        Err(e) => {
            tracing::error!(error = %e, "WebTransport disabled");
            return None;
        }
    };
    // Dual-stack where the host has IPv6 (containers often don't), else IPv4.
    let v6 = SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, settings.port));
    let v4 = SocketAddr::from((Ipv4Addr::UNSPECIFIED, settings.port));
    let (endpoint, addr) = match Endpoint::server(server_config(v6, identity.clone_identity())) {
        Ok(e) => (e, v6),
        Err(_) => match Endpoint::server(server_config(v4, identity)) {
            Ok(e) => (e, v4),
            Err(e) => {
                tracing::error!(port = settings.port, error = %e, "can't bind the WebTransport UDP port; WebTransport disabled");
                return None;
            }
        },
    };
    let info = WtInfo { port: settings.public_port.unwrap_or(settings.port), hashes };
    tracing::info!(
        udp_port = settings.port,
        public_port = info.port,
        self_signed = !info.hashes.is_empty(),
        "WebTransport listening"
    );
    let endpoint = Arc::new(endpoint);
    tokio::spawn(renew_certificates(endpoint.clone(), addr, certs, state.webtransport.clone()));
    tokio::spawn(accept_loop(endpoint, state));
    Some(info)
}

/// Swaps in a new certificate when it's due (self-signed) or its files
/// changed; connections already open keep theirs.
async fn renew_certificates(endpoint: Arc<Endpoint<wtransport::endpoint::endpoint_side::Server>>, addr: SocketAddr, mut certs: Certs, info: Arc<RwLock<Option<WtInfo>>>) {
    loop {
        tokio::time::sleep(certs.check_every()).await;
        if !certs.stale() {
            continue;
        }
        match certs.load().await {
            Ok((identity, hashes)) => {
                if let Err(e) = endpoint.reload_config(server_config(addr, identity), false) {
                    tracing::warn!(error = %e, "WebTransport certificate reload failed");
                    continue;
                }
                if let Some(info) = info.write().unwrap_or_else(std::sync::PoisonError::into_inner).as_mut() {
                    info.hashes = hashes;
                }
                tracing::info!("WebTransport certificate renewed");
            }
            Err(e) => tracing::warn!(error = %e, "WebTransport certificate renewal failed; keeping the old one"),
        }
    }
}

async fn accept_loop(endpoint: Arc<Endpoint<wtransport::endpoint::endpoint_side::Server>>, state: AppState) {
    loop {
        let incoming = endpoint.accept().await;
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = accept(incoming, state).await {
                tracing::debug!(error = %e, "WebTransport session not established");
            }
        });
    }
}

/// The arena from a `/wt?arena=N` path; `None` for any other path.
fn arena_from_path(path: &str) -> Option<usize> {
    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    if route != "/wt" {
        return None;
    }
    let arena = query.split('&').find_map(|kv| kv.strip_prefix("arena=")).and_then(|v| v.parse().ok());
    Some(arena.unwrap_or(0))
}

async fn accept(incoming: IncomingSession, state: AppState) -> Result<(), String> {
    let request = incoming.await.map_err(|e| e.to_string())?;
    let Some(arena) = arena_from_path(request.path()) else {
        request.not_found().await;
        return Ok(());
    };
    let peer = request.remote_address();
    let handle = state.arenas[arena.min(state.arenas.len() - 1)].clone();
    let span = tracing::info_span!("session", arena = %handle.name, %peer, id = tracing::field::Empty);
    async move {
        let conn = request.accept().await.map_err(|e| e.to_string())?;
        let (send, recv) = tokio::time::timeout(STREAM_TIMEOUT, conn.accept_bi())
            .await
            .map_err(|_| "no stream opened".to_owned())?
            .map_err(|e| e.to_string())?;
        net::session(WtIn { recv }, WtOut { send, conn, frame: BytesMut::with_capacity(4096) }, handle, state.db).await;
        Ok(())
    }
    .instrument(span)
    .await
}

/// Reads length-prefixed frames from the client's stream.
struct WtIn {
    recv: RecvStream,
}

impl Inbound for WtIn {
    async fn recv(&mut self) -> Result<Bytes, &'static str> {
        let mut len = [0u8; 4];
        self.recv.read_exact(&mut len).await.map_err(read_error)?;
        let len = u32::from_le_bytes(len) as usize;
        if len > MAX_CLIENT_MSG {
            tracing::info!(bytes = len, "client message too large");
            return Err("message too large");
        }
        let mut buf = vec![0u8; len];
        self.recv.read_exact(&mut buf).await.map_err(read_error)?;
        Ok(Bytes::from(buf))
    }
}

fn read_error(e: StreamReadExactError) -> &'static str {
    match e {
        StreamReadExactError::FinishedEarly(_) => "closed by client",
        StreamReadExactError::Read(e) => {
            tracing::debug!(error = %e, "stream read failed");
            "connection lost"
        }
    }
}

/// Writes length-prefixed frames to the stream, and snapshots as datagrams.
struct WtOut {
    send: SendStream,
    conn: Connection,
    /// Reused buffer for one frame (length and message, one write).
    frame: BytesMut,
}

impl Outbound for WtOut {
    const KIND: &'static str = "webtransport";

    async fn send(&mut self, msg: Bytes) -> Result<(), String> {
        self.frame.clear();
        self.frame.put_u32_le(u32::try_from(msg.len()).map_err(|_| "message too large".to_owned())?);
        self.frame.extend_from_slice(&msg);
        self.send.write_all(&self.frame).await.map_err(|e| e.to_string())
    }

    async fn send_snapshot(&mut self, msg: Bytes) -> Result<(), String> {
        if self.conn.max_datagram_size().is_some_and(|max| msg.len() <= max) {
            match self.conn.send_datagram(&msg) {
                Ok(()) => return Ok(()),
                // Too big after all (the path shrank): use the stream.
                Err(SendDatagramError::TooLarge | SendDatagramError::UnsupportedByPeer) => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        self.send(msg).await
    }

    async fn close(mut self) {
        // Let the last messages (a refusal, say) arrive, then close.
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            let _ = self.send.finish().await;
        })
        .await;
        self.conn.close(0u32.into(), b"");
    }
}

#[cfg(test)]
mod tests {
    use super::{arena_from_path, hex};

    #[test]
    fn paths() {
        assert_eq!(arena_from_path("/wt?arena=3"), Some(3));
        assert_eq!(arena_from_path("/wt"), Some(0));
        assert_eq!(arena_from_path("/wt?x=1&arena=2"), Some(2));
        assert_eq!(arena_from_path("/ws?arena=1"), None);
    }

    #[test]
    fn hex_digits() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }
}
