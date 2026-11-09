//! WebSocket sessions: handshake, then a reader that writes input into the
//! client's lock-free slot and a writer that forwards reliable events and
//! the newest snapshot.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use bytes::{Bytes, BytesMut};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};

use crate::game::GameEvent;
use crate::game::link::{ClientLink, EVENT_QUEUE, InputSlot, SnapshotSlot};
use crate::protocol::{self, ClientMsg, ServerMsg};

const JOIN_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_MSGS_PER_SEC: u32 = 60;
const MAX_NAME_LEN: usize = 16;

#[derive(Clone)]
pub struct AppState {
    pub game: mpsc::Sender<GameEvent>,
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.max_message_size(4096).on_upgrade(move |socket| session(socket, state))
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

async fn session(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();

    // Handshake: the first message must be a join.
    let name = match tokio::time::timeout(JOIN_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Binary(data)))) => match ClientMsg::decode(&data) {
            Some(ClientMsg::Join { name }) => sanitize_name(name),
            _ => return,
        },
        _ => return,
    };

    let (events_tx, mut events_rx) = mpsc::channel::<Bytes>(EVENT_QUEUE);
    let pong_tx = events_tx.downgrade();
    let snapshot = Arc::new(SnapshotSlot::default());
    let input = Arc::new(InputSlot::default());
    let link = ClientLink { events: events_tx, snapshot: snapshot.clone(), input: input.clone() };
    let (reply_tx, reply_rx) = oneshot::channel();
    if state.game.send(GameEvent::Join { name, link, reply: reply_tx }).await.is_err() {
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
                Some(ClientMsg::In { d, s }) => input.set_dirs(d, s),
                Some(ClientMsg::Bomb) => input.press_bomb(),
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
    let _ = state.game.send(GameEvent::Leave { id }).await;
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
