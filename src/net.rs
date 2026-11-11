//! Client sessions: handshake (arena choice, profile), then a reader that
//! writes input into the client's lock-free slot and a writer that forwards
//! reliable events and the newest snapshot.
//!
//! A session runs over any transport with an [`Inbound`] and an [`Outbound`]
//! half: a WebSocket (here) or WebTransport (`crate::wt`), where snapshots
//! go as unreliable datagrams so a lost packet doesn't hold back newer ones.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::{Arc, RwLock};
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering::Relaxed;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::response::Response;
use bytes::{Bytes, BytesMut};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};
use tracing::Instrument;

use crate::db::{self, Db};
use crate::game::link::{ClientLink, EVENT_QUEUE, InputSlot, SnapshotSlot};
use crate::game::{GameEvent, JoinRequest, Mode};
use crate::metrics::ArenaStats;
use crate::protocol::{self, ClientMsg};

const JOIN_TIMEOUT: Duration = Duration::from_secs(15);
/// Inputs arrive up to 20/s for prediction, plus pings and the odd emote.
const MAX_MSGS_PER_SEC: u32 = 80;
const MAX_NAME_LEN: usize = 16;

/// One running arena: its game task and live stats.
#[derive(Clone)]
pub struct ArenaHandle {
    pub name: String,
    pub mode: Mode,
    pub map_size: i32,
    pub max_players: usize,
    pub game: mpsc::Sender<GameEvent>,
    pub live: Arc<ArenaStats>,
}

#[derive(Clone)]
pub struct AppState {
    pub arenas: Arc<Vec<ArenaHandle>>,
    pub db: Option<Db>,
    pub started: Instant,
    pub sys: Arc<std::sync::Mutex<sysinfo::System>>,
    /// Where browsers reach the WebTransport endpoint (`None` when it's off).
    pub webtransport: Arc<RwLock<Option<crate::wt::WtInfo>>>,
}

/// The receiving half of a client connection.
pub trait Inbound: Send + 'static {
    /// The next message from the client, or why the connection ended.
    fn recv(&mut self) -> impl Future<Output = Result<Bytes, &'static str>> + Send;
}

/// The sending half of a client connection.
pub trait Outbound: Send + 'static {
    /// Which transport this is, for the logs.
    const KIND: &'static str;
    /// Sends a message reliably and in order with the other reliable ones.
    fn send(&mut self, msg: Bytes) -> impl Future<Output = Result<(), String>> + Send;
    /// Sends a snapshot. It may be dropped or arrive out of order: snapshots
    /// are deltas against one the client confirmed, and the client skips
    /// stale ones. By default it goes like any other message.
    fn send_snapshot(&mut self, msg: Bytes) -> impl Future<Output = Result<(), String>> + Send {
        self.send(msg)
    }
    /// Flushes what was sent and closes the connection.
    fn close(self) -> impl Future<Output = ()> + Send;
}

#[derive(Deserialize)]
pub struct WsQuery {
    arena: Option<usize>,
}

#[allow(clippy::unused_async, reason = "axum handlers must be async")]
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(q): Query<WsQuery>,
    State(state): State<AppState>,
) -> Response {
    let arena = q.arena.unwrap_or(0).min(state.arenas.len() - 1);
    let handle = state.arenas[arena].clone();
    // Every log line of the session carries the arena, the peer and, once
    // joined, the player id.
    let span = tracing::info_span!("session", arena = %handle.name, %peer, id = tracing::field::Empty);
    ws.max_message_size(4096)
        .on_failed_upgrade(move |e| tracing::warn!(%peer, error = %e, "websocket upgrade failed"))
        .on_upgrade(move |socket| {
            let (sink, stream) = socket.split();
            session(WsIn(stream), WsOut(sink), handle, state.db).instrument(span)
        })
}

/// A WebSocket's receiving half: binary messages; pings and text are skipped.
struct WsIn(SplitStream<WebSocket>);

impl Inbound for WsIn {
    async fn recv(&mut self) -> Result<Bytes, &'static str> {
        loop {
            match self.0.next().await {
                Some(Ok(Message::Binary(data))) => return Ok(data),
                Some(Ok(Message::Close(frame))) => {
                    tracing::debug!(code = frame.as_ref().map(|f| f.code), "client sent close");
                    return Err("closed by client");
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => {
                    tracing::debug!(error = %e, "socket read failed");
                    return Err("read failed");
                }
                None => return Err("connection lost"),
            }
        }
    }
}

/// A WebSocket's sending half: everything in order, snapshots included.
struct WsOut(SplitSink<WebSocket, Message>);

impl Outbound for WsOut {
    const KIND: &'static str = "websocket";

    async fn send(&mut self, msg: Bytes) -> Result<(), String> {
        self.0.send(Message::Binary(msg)).await.map_err(|e| e.to_string())
    }

    async fn close(mut self) {
        let _ = self.0.close().await;
    }
}

#[must_use]
pub fn sanitize_name(raw: &str) -> String {
    let name: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '_' | '-' | '.'))
        .take(MAX_NAME_LEN)
        .collect();
    let name = name.trim();
    if name.is_empty() { "Blaster".to_string() } else { name.to_string() }
}

/// Message counters for one connection, for the disconnect log line.
#[derive(Default)]
struct Traffic {
    msgs_in: AtomicU64,
    msgs_out: AtomicU64,
    bytes_out: AtomicU64,
}

/// Runs one client's session over a transport: join, play, leave.
pub(crate) async fn session<I: Inbound, O: Outbound>(mut stream: I, mut sink: O, arena: ArenaHandle, db: Option<Db>) {
    tracing::debug!(transport = O::KIND, "connection opened");
    let Some(req) = handshake(&mut stream, db.as_ref()).await else { return };
    let name = req.name.clone();
    let has_profile = req.profile.is_some();
    let near = req.near;

    let (events_tx, events_rx) = mpsc::channel::<Bytes>(EVENT_QUEUE);
    let pong_tx = events_tx.downgrade();
    let snapshot = Arc::new(SnapshotSlot::default());
    let input = Arc::new(InputSlot::default());
    let link = ClientLink { events: events_tx, snapshot: snapshot.clone(), input: input.clone() };
    let (reply_tx, reply_rx) = oneshot::channel();
    if arena.game.send(GameEvent::Join { req, link, reply: reply_tx }).await.is_err() {
        tracing::error!("arena task is gone; join dropped");
        return;
    }
    let id = match reply_rx.await {
        Ok(Ok(id)) => id,
        Ok(Err(reason)) => {
            tracing::info!(%name, reason, "join refused");
            let _ = sink.send(protocol::encode_err(reason)).await;
            sink.close().await;
            return;
        }
        Err(_) => {
            tracing::error!("arena task dropped the join reply");
            return;
        }
    };
    tracing::Span::current().record("id", id);
    tracing::info!(%name, profile = has_profile, ?near, transport = O::KIND, "player joined");
    let started = Instant::now();
    let traffic = Arc::new(Traffic::default());

    let mut writer = tokio::spawn(write_loop(sink, events_rx, snapshot, arena.live.clone(), traffic.clone()).in_current_span());
    let mut reader = tokio::spawn(read_loop(stream, input, pong_tx, traffic.clone()).in_current_span());
    let reason = tokio::select! {
        r = &mut writer => {
            reader.abort();
            r.unwrap_or("writer panicked")
        }
        r = &mut reader => {
            writer.abort();
            r.unwrap_or("reader panicked")
        }
    };
    let _ = arena.game.send(GameEvent::Leave { id }).await;
    tracing::info!(
        %name,
        reason,
        secs = started.elapsed().as_secs(),
        msgs_in = traffic.msgs_in.load(Relaxed),
        msgs_out = traffic.msgs_out.load(Relaxed),
        kb_out = traffic.bytes_out.load(Relaxed) / 1024,
        "player disconnected"
    );
}

/// Waits for the join message (the first message must be one) and loads,
/// or starts, the player's profile. `None` if the client didn't join.
async fn handshake(stream: &mut impl Inbound, db: Option<&Db>) -> Option<JoinRequest> {
    let data = match tokio::time::timeout(JOIN_TIMEOUT, stream.recv()).await {
        Ok(Ok(data)) => data,
        Ok(Err(reason)) => {
            tracing::debug!(reason, "connection ended before joining");
            return None;
        }
        Err(_) => {
            tracing::info!(timeout_secs = JOIN_TIMEOUT.as_secs(), "handshake timed out");
            return None;
        }
    };
    let Some(ClientMsg::Join { name, token, hat, trail, near }) = ClientMsg::decode(&data) else {
        tracing::info!(bytes = data.len(), "handshake rejected: first message is not a valid join");
        return None;
    };
    let mut req = JoinRequest {
        name: sanitize_name(name),
        token: db::valid_token(token).then(|| token.to_string()),
        hat,
        trail,
        near,
        profile: None,
    };
    if let (Some(db), Some(token)) = (db, &req.token) {
        let mut profile = db.load(token).await.unwrap_or_else(|| db::Profile { token: token.clone(), ..Default::default() });
        profile.name.clone_from(&req.name);
        profile.hat = profile.allowed_hat(req.hat);
        profile.trail = profile.allowed_trail(req.trail);
        tracing::debug!(level = profile.level(), kills = profile.kills, "profile loaded");
        req.profile = Some(profile);
    }
    Some(req)
}

/// Sends events first, so the welcome always precedes snapshots, then the
/// newest snapshot. Ends when the game drops the client's event sender (on
/// leave, or when the client can't keep up), which closes the socket.
async fn write_loop(
    mut sink: impl Outbound,
    mut events: mpsc::Receiver<Bytes>,
    snapshot: Arc<SnapshotSlot>,
    live: Arc<ArenaStats>,
    traffic: Arc<Traffic>,
) -> &'static str {
    loop {
        let (msg, is_snapshot) = tokio::select! {
            biased;
            ev = events.recv() => match ev {
                Some(ev) => (ev, false),
                None => break,
            },
            snap = snapshot.next() => (snap, true),
        };
        let len = msg.len() as u64;
        live.bytes_out.fetch_add(len, Relaxed);
        traffic.msgs_out.fetch_add(1, Relaxed);
        traffic.bytes_out.fetch_add(len, Relaxed);
        let sent = if is_snapshot { sink.send_snapshot(msg).await } else { sink.send(msg).await };
        if let Err(e) = sent {
            tracing::debug!(error = %e, "socket write failed");
            return "write failed";
        }
    }
    sink.close().await;
    "closed by server"
}

/// Feeds client messages into the input slot, answers pings, and enforces
/// the message rate limit. Returns why the connection ended.
async fn read_loop(
    mut stream: impl Inbound,
    input: Arc<InputSlot>,
    pong_tx: mpsc::WeakSender<Bytes>,
    traffic: Arc<Traffic>,
) -> &'static str {
    let mut window = Instant::now();
    let mut count = 0u32;
    let mut unknown = 0u32;
    // Pongs are encoded into a small per-connection arena.
    let mut arena = BytesMut::with_capacity(256);
    loop {
        let data = match stream.recv().await {
            Ok(data) => data,
            Err(reason) => return reason,
        };
        traffic.msgs_in.fetch_add(1, Relaxed);
        if window.elapsed() >= Duration::from_secs(1) {
            window = Instant::now();
            count = 0;
        }
        count += 1;
        if count > MAX_MSGS_PER_SEC {
            tracing::warn!(limit = MAX_MSGS_PER_SEC, "client exceeded message rate, disconnecting");
            return "rate limited";
        }
        match ClientMsg::decode(&data) {
            Some(ClientMsg::In { d, s, j, h, q, k }) => {
                input.set_input(d, s, j, h, q);
                input.set_ack(k);
            }
            Some(ClientMsg::Bomb) => input.press_bomb(),
            Some(ClientMsg::Act) => input.press_act(),
            Some(ClientMsg::Gadget) => input.press_gadget(),
            Some(ClientMsg::Ability) => input.press_ability(),
            Some(ClientMsg::Cancel) => input.press_cancel(),
            Some(ClientMsg::Emote { e }) => input.emote(e),
            Some(ClientMsg::View { w, h }) => {
                tracing::trace!(w, h, "view requested");
                input.set_view(w, h);
            }
            Some(ClientMsg::Look { at }) => input.set_look(at),
            Some(ClientMsg::Ping { c }) => {
                // Answer directly so latency doesn't include tick wait.
                if let Some(tx) = pong_tx.upgrade() {
                    let _ = tx.try_send(protocol::encode_pong(&mut arena, c));
                }
            }
            _ => {
                // Log the first few only, so a broken client can't flood the log.
                unknown += 1;
                if unknown <= 3 {
                    tracing::debug!(bytes = data.len(), "ignored unknown or malformed message");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_name;

    #[test]
    fn names_are_sanitized() {
        assert_eq!(sanitize_name("  <b>hi</b> "), "bhib");
        assert_eq!(sanitize_name(""), "Blaster");
        assert_eq!(sanitize_name("a_very_long_name_indeed_yes").len(), 16);
    }
}
