//! Load tester: connects N headless bots that wander, drop bombs and measure
//! round-trip latency, to check the server copes with 100+ players.
//!
//! Usage: cargo run --release --bin bots -- [--count 150] [--url ws://127.0.0.1:3000/ws] [--secs 0]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio_tungstenite::{connect_async, tungstenite::Message};

/// Client messages, MessagePack-encoded like the browser client does.
#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Out<'a> {
    Join { name: &'a str },
    In { d: u8 },
    Bomb,
    Ping { c: f64 },
}

fn frame(m: &Out) -> Message {
    Message::Binary(rmp_serde::to_vec_named(m).expect("bot messages serialize").into())
}

#[derive(Deserialize)]
struct Pong {
    c: f64,
}

/// MessagePack prefix of `{"t": "pong", ...}`: a 2-entry map whose first key
/// is "t" with value "pong". Lets bots skip decoding every snapshot.
const PONG_PREFIX: &[u8] = &[0x82, 0xa1, b't', 0xa4, b'p', b'o', b'n', b'g'];

#[derive(Default)]
struct Stats {
    connected: AtomicU64,
    messages: AtomicU64,
    bytes: AtomicU64,
    rtt_us_sum: AtomicU64,
    rtt_count: AtomicU64,
    rtt_us_max: AtomicU64,
    disconnects: AtomicU64,
}

fn arg<T: std::str::FromStr>(name: &str, default: T) -> T {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Tiny per-bot PRNG so the bots don't need a dependency.
fn next_rand(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

async fn bot(n: u32, url: String, stats: Arc<Stats>, epoch: Instant) {
    let Ok((ws, _)) = connect_async(&url).await else {
        stats.disconnects.fetch_add(1, Relaxed);
        return;
    };
    stats.connected.fetch_add(1, Relaxed);
    let (mut tx, mut rx) = ws.split();
    let name = format!("bot-{n}");
    if tx.send(frame(&Out::Join { name: &name })).await.is_err() {
        return;
    }

    let mut seed = 0x2545_F491_4F6C_DD1Du64 ^ (n as u64 + 1).wrapping_mul(0x9E37_79B9);
    let mut next_action = tokio::time::interval(Duration::from_millis(250 + n as u64 % 100));
    let mut ping = tokio::time::interval(Duration::from_secs(2));
    loop {
        tokio::select! {
            msg = rx.next() => {
                let Some(Ok(msg)) = msg else { break };
                if let Message::Binary(data) = msg {
                    stats.messages.fetch_add(1, Relaxed);
                    stats.bytes.fetch_add(data.len() as u64, Relaxed);
                    if data.starts_with(PONG_PREFIX) {
                        if let Ok(pong) = rmp_serde::from_slice::<Pong>(&data) {
                            let rtt = (epoch.elapsed().as_secs_f64() * 1e6 - pong.c) as u64;
                            stats.rtt_us_sum.fetch_add(rtt, Relaxed);
                            stats.rtt_count.fetch_add(1, Relaxed);
                            stats.rtt_us_max.fetch_max(rtt, Relaxed);
                        }
                    }
                }
            }
            _ = next_action.tick() => {
                let r = next_rand(&mut seed);
                let mut out = Vec::new();
                if r % 3 == 0 {
                    out.push(Out::In { d: ((r >> 8) % 5) as u8 });
                }
                if r % 23 == 0 {
                    out.push(Out::Bomb);
                }
                for m in &out {
                    if tx.send(frame(m)).await.is_err() {
                        break;
                    }
                }
            }
            _ = ping.tick() => {
                let c = epoch.elapsed().as_secs_f64() * 1e6;
                if tx.send(frame(&Out::Ping { c })).await.is_err() {
                    break;
                }
            }
        }
    }
    stats.connected.fetch_sub(1, Relaxed);
    stats.disconnects.fetch_add(1, Relaxed);
}

#[tokio::main]
async fn main() {
    let count: u32 = arg("--count", 150);
    let url: String = arg("--url", "ws://127.0.0.1:3000/ws".to_string());
    let secs: u64 = arg("--secs", 0);
    let stats = Arc::new(Stats::default());
    let epoch = Instant::now();

    println!("spawning {count} bots against {url}");
    for n in 0..count {
        tokio::spawn(bot(n, url.clone(), stats.clone(), epoch));
        // Stagger connections a little, like real players arriving.
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let started = Instant::now();
    let mut report = tokio::time::interval(Duration::from_secs(5));
    report.tick().await;
    loop {
        report.tick().await;
        let msgs = stats.messages.swap(0, Relaxed);
        let bytes = stats.bytes.swap(0, Relaxed);
        let rtt_n = stats.rtt_count.swap(0, Relaxed).max(1);
        let rtt_sum = stats.rtt_us_sum.swap(0, Relaxed);
        let rtt_max = stats.rtt_us_max.swap(0, Relaxed);
        let online = stats.connected.load(Relaxed);
        println!(
            "bots online {online:>4} | msgs/s {:>7.0} | per bot {:>5.1} msg/s {:>6.1} KB/s | rtt avg {:>6.2} ms max {:>6.2} ms | disconnects {}",
            msgs as f64 / 5.0,
            msgs as f64 / 5.0 / online.max(1) as f64,
            bytes as f64 / 5.0 / 1024.0 / online.max(1) as f64,
            rtt_sum as f64 / rtt_n as f64 / 1000.0,
            rtt_max as f64 / 1000.0,
            stats.disconnects.load(Relaxed),
        );
        if secs > 0 && started.elapsed().as_secs() >= secs {
            break;
        }
    }
}
