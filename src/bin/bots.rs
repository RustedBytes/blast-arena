//! Load tester: connects N headless bots that wander, drop bombs and measure
//! round-trip latency, to check the server copes with 100+ players.
//!
//! Usage: cargo run --release --bin bots -- [--count 150] [--url <ws://127.0.0.1:3000/ws>] [--secs 0]

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use blast_arena::protocol::{self, ClientMsg};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};

fn frame(m: &ClientMsg) -> Message {
    Message::Binary(m.encode())
}

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

/// Network load tester for the Blast Arena server.
#[derive(Parser)]
#[command(version, about)]
struct Args {
    /// Number of bot connections to open.
    #[arg(long, default_value_t = 150)]
    count: u32,
    /// WebSocket endpoint of the server.
    #[arg(long, default_value = "ws://127.0.0.1:3000/ws")]
    url: String,
    /// Stop after this many seconds (0 runs forever).
    #[arg(long, default_value_t = 0)]
    secs: u64,
}

/// Tiny per-bot PRNG so the bots don't need a dependency.
fn next_rand(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

#[allow(clippy::many_single_char_names, reason = "d, s, q and k are the input message's wire keys")]
async fn bot(n: u32, url: String, stats: Arc<Stats>, epoch: Instant) {
    let Ok((ws, _)) = connect_async(&url).await else {
        stats.disconnects.fetch_add(1, Relaxed);
        return;
    };
    stats.connected.fetch_add(1, Relaxed);
    let (mut tx, mut rx) = ws.split();
    let name = format!("bot-{n}");
    if tx.send(frame(&ClientMsg::Join { name: &name, token: "", hat: 0, trail: 0, near: 0 })).await.is_err() {
        return;
    }
    // Ask for a typical zoomed-out view, like a browser on a large screen.
    if tx.send(frame(&ClientMsg::View { w: 20, h: 13 })).await.is_err() {
        return;
    }

    let mut seed = 0x2545_F491_4F6C_DD1Du64 ^ (u64::from(n) + 1).wrapping_mul(0x9E37_79B9);
    let mut next_action = tokio::time::interval(Duration::from_millis(250 + u64::from(n) % 100));
    // Like the browser: send the held input (and the newest snapshot tick,
    // which lets the server send deltas) at the 20 Hz input rate.
    let mut input_tick = tokio::time::interval(Duration::from_millis(50));
    let mut ping = tokio::time::interval(Duration::from_secs(2));
    let (mut d, mut s, mut q, mut last_k) = (0u8, 0u8, 0u16, 0u32);
    loop {
        tokio::select! {
            msg = rx.next() => {
                let Some(Ok(msg)) = msg else { break };
                if let Message::Binary(data) = msg {
                    stats.messages.fetch_add(1, Relaxed);
                    stats.bytes.fetch_add(data.len() as u64, Relaxed);
                    if let Some(k) = protocol::peek_snapshot_tick(&data) {
                        last_k = k as u32;
                    } else if let Some(c) = protocol::peek_pong(&data) {
                        let rtt = (epoch.elapsed().as_secs_f64() * 1e6 - c) as u64;
                        stats.rtt_us_sum.fetch_add(rtt, Relaxed);
                        stats.rtt_count.fetch_add(1, Relaxed);
                        stats.rtt_us_max.fetch_max(rtt, Relaxed);
                    }
                }
            }
            _ = input_tick.tick() => {
                q = q.wrapping_add(1);
                if tx.send(frame(&ClientMsg::In { d, s, j: false, q, k: last_k })).await.is_err() {
                    break;
                }
            }
            _ = next_action.tick() => {
                let r = next_rand(&mut seed);
                if r.is_multiple_of(3) {
                    (d, s) = (((r >> 8) % 5) as u8, ((r >> 16) % 5) as u8);
                }
                if r.is_multiple_of(23) && tx.send(frame(&ClientMsg::Bomb)).await.is_err() {
                    break;
                }
            }
            _ = ping.tick() => {
                let c = epoch.elapsed().as_secs_f64() * 1e6;
                if tx.send(frame(&ClientMsg::Ping { c })).await.is_err() {
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
    let Args { count, url, secs } = Args::parse();
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
