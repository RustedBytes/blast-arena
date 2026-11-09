//! WebSocket sessions: handshake (arena choice, profile), then a reader that
//! writes input into the client's lock-free slot and a writer that forwards
//! reliable events and the newest snapshot.

use std::sync::Arc;
use std::sync::atomic::Ordering::Relaxed;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use bytes::{Bytes, BytesMut};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};

use crate::db::{self, Db};
use crate::game::link::{ClientLink, EVENT_QUEUE, InputSlot, SnapshotSlot};
use crate::game::{GameEvent, JoinRequest, Mode};
use crate::metrics::ArenaStats;
use crate::protocol::{self, ClientMsg, ServerMsg};

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
}

#[derive(Deserialize)]
pub struct WsQuery {
    arena: Option<usize>,
}

pub async fn ws_handler(ws: WebSocketUpgrade, Query(q): Query<WsQuery>, State(state): State<AppState>) -> Response {
    let arena = q.arena.unwrap_or(0).min(state.arenas.len() - 1);
    let handle = state.arenas[arena].clone();
    ws.max_message_size(4096).on_upgrade(move |socket| session(socket, handle, state.db))
}

pub fn sanitize_name(raw: &str) -> String {
    let name: String = raw
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '_' | '-' | '.'))
        .take(MAX_NAME_LEN)
        .collect();
    let name = name.trim();
    if name.is_empty() { "Blaster".to_string() } else { name.to_string() }
}

async fn session(socket: WebSocket, arena: ArenaHandle, db: Option<Db>) {
    let (mut sink, mut stream) = socket.split();

    // Handshake: the first message must be a join.
    let mut req = match tokio::time::timeout(JOIN_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Binary(data)))) => match ClientMsg::decode(&data) {
            Some(ClientMsg::Join { name, token, hat, trail, near }) => JoinRequest {
                name: sanitize_name(name),
                token: db::valid_token(token).then(|| token.to_string()),
                hat,
                trail,
                near,
                profile: None,
            },
            _ => return,
        },
        _ => return,
    };
    // Load (or start) the player's profile before joining.
    if let (Some(db), Some(token)) = (&db, &req.token) {
        let mut profile = db.load(token).await.unwrap_or_else(|| db::Profile { token: token.clone(), ..Default::default() });
        profile.name.clone_from(&req.name);
        profile.hat = profile.allowed_hat(req.hat);
        profile.trail = profile.allowed_trail(req.trail);
        req.profile = Some(profile);
    }

    let (events_tx, mut events_rx) = mpsc::channel::<Bytes>(EVENT_QUEUE);
    let pong_tx = events_tx.downgrade();
    let snapshot = Arc::new(SnapshotSlot::default());
    let input = Arc::new(InputSlot::default());
    let link = ClientLink { events: events_tx, snapshot: snapshot.clone(), input: input.clone() };
    let (reply_tx, reply_rx) = oneshot::channel();
    if arena.game.send(GameEvent::Join { req, link, reply: reply_tx }).await.is_err() {
        return;
    }
    let id = match reply_rx.await {
        Ok(Ok(id)) => id,
        Ok(Err(reason)) => {
            let _ = sink.send(Message::Binary(ServerMsg::Err { m: reason }.encode())).await;
            let _ = sink.close().await;
            return;
        }
        Err(_) => return,
    };

    // Events go first so the welcome always precedes snapshots. The writer
    // ends when the game drops the client's event sender (on leave, or when
    // the client can't keep up), which closes the socket.
    let live = arena.live.clone();
    let mut writer = tokio::spawn(async move {
        loop {
            let msg = tokio::select! {
                biased;
                ev = events_rx.recv() => match ev {
                    Some(ev) => ev,
                    None => break,
                },
                snap = snapshot.next() => snap,
            };
            live.bytes_out.fetch_add(msg.len() as u64, Relaxed);
            if sink.send(Message::Binary(msg)).await.is_err() {
                return;
            }
        }
        let _ = sink.close().await;
    });

    let mut reader = tokio::spawn(async move {
        let mut window = Instant::now();
        let mut count = 0u32;
        // Pongs are encoded into a small per-connection arena.
        let mut arena = BytesMut::with_capacity(256);
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Binary(data) = msg else {
                if matches!(msg, Message::Close(_)) {
                    break;
                }
                continue;
            };
            if window.elapsed() >= Duration::from_secs(1) {
                window = Instant::now();
                count = 0;
            }
            count += 1;
            if count > MAX_MSGS_PER_SEC {
                tracing::warn!(id, "client exceeded message rate, disconnecting");
                break;
            }
            match ClientMsg::decode(&data) {
                Some(ClientMsg::In { d, s, q, k }) => {
                    input.set_dirs(d, s, q);
                    input.set_ack(k);
                }
                Some(ClientMsg::Bomb) => input.press_bomb(),
                Some(ClientMsg::Act) => input.press_act(),
                Some(ClientMsg::Emote { e }) => input.emote(e),
                Some(ClientMsg::View { w, h }) => input.set_view(w, h),
                Some(ClientMsg::Ping { c }) => {
                    // Answer directly so latency doesn't include tick wait.
                    if let Some(tx) = pong_tx.upgrade() {
                        let _ = tx.try_send(protocol::encode_pong(&mut arena, c));
                    }
                }
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut writer => reader.abort(),
        _ = &mut reader => writer.abort(),
    }
    let _ = arena.game.send(GameEvent::Leave { id }).await;
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
