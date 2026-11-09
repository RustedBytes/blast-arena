//! HTTP endpoints: the lobby's arena list, the all-time leaderboard,
//! profiles, a JSON stats feed for the dashboard, and Prometheus metrics.

use std::fmt::Write as _;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use serde::{Deserialize, Serialize};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate};

use crate::db::{self, HAT_LEVELS, TRAIL_LEVELS};
use crate::metrics::ArenaSnapshot;
use crate::net::AppState;

#[derive(Serialize)]
pub struct ArenaInfo {
    id: usize,
    name: String,
    mode: &'static str,
    map: i32,
    max_players: usize,
    #[serde(flatten)]
    live: ArenaSnapshot,
}

fn arena_infos(state: &AppState) -> Vec<ArenaInfo> {
    state
        .arenas
        .iter()
        .enumerate()
        .map(|(id, a)| ArenaInfo {
            id,
            name: a.name.clone(),
            mode: a.mode.as_str(),
            map: a.map_size,
            max_players: a.max_players,
            live: a.live.snapshot(),
        })
        .collect()
}

pub async fn arenas(State(state): State<AppState>) -> Json<Vec<ArenaInfo>> {
    Json(arena_infos(&state))
}

#[derive(Serialize)]
pub struct LeaderRow {
    name: String,
    level: u32,
    xp: u64,
    kills: u64,
    deaths: u64,
    wins: u64,
    best_streak: u64,
}

pub async fn leaderboard(State(state): State<AppState>) -> Json<Vec<LeaderRow>> {
    let Some(db) = &state.db else { return Json(Vec::new()) };
    let rows = db
        .top(20)
        .await
        .into_iter()
        .map(|p| LeaderRow {
            level: p.level(),
            name: p.name,
            xp: p.xp,
            kills: p.kills,
            deaths: p.deaths,
            wins: p.wins,
            best_streak: p.best_streak,
        })
        .collect();
    Json(rows)
}

#[derive(Deserialize)]
pub struct ProfileQuery {
    token: String,
}

#[derive(Serialize)]
pub struct ProfileResponse {
    level: u32,
    xp: u64,
    level_xp: u64,
    next_xp: u64,
    kills: u64,
    deaths: u64,
    wins: u64,
    best_streak: u64,
    games: u64,
    hat: u8,
    trail: u8,
    hat_levels: &'static [u32],
    trail_levels: &'static [u32],
}

pub async fn profile(State(state): State<AppState>, Query(q): Query<ProfileQuery>) -> impl IntoResponse {
    let p = match (&state.db, db::valid_token(&q.token)) {
        (Some(db), true) => db.load(&q.token).await.unwrap_or_default(),
        _ => db::Profile::default(),
    };
    let level = p.level();
    Json(ProfileResponse {
        level,
        xp: p.xp,
        level_xp: db::xp_for_level(level),
        next_xp: db::xp_for_level(level + 1),
        kills: p.kills,
        deaths: p.deaths,
        wins: p.wins,
        best_streak: p.best_streak,
        games: p.games,
        hat: p.hat,
        trail: p.trail,
        hat_levels: &HAT_LEVELS,
        trail_levels: &TRAIL_LEVELS,
    })
}

#[derive(Serialize)]
pub struct Stats {
    uptime_s: u64,
    cpu_percent: f32,
    memory_mb: f64,
    cores: usize,
    arenas: Vec<ArenaInfo>,
}

/// Process CPU (percent of one core) and resident memory in MB.
fn process_usage(state: &AppState) -> (f32, f64, usize) {
    let mut sys = state.sys.lock().unwrap();
    let Ok(pid) = sysinfo::get_current_pid() else { return (0.0, 0.0, 1) };
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing().with_cpu().with_memory());
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    match sys.process(pid) {
        Some(p) => (p.cpu_usage(), p.memory() as f64 / (1024.0 * 1024.0), cores),
        None => (0.0, 0.0, cores),
    }
}

pub async fn stats(State(state): State<AppState>) -> Json<Stats> {
    let (cpu_percent, memory_mb, cores) = process_usage(&state);
    Json(Stats { uptime_s: state.started.elapsed().as_secs(), cpu_percent, memory_mb, cores, arenas: arena_infos(&state) })
}

/// Prometheus text exposition format.
pub async fn metrics(State(state): State<AppState>) -> impl IntoResponse {
    let (cpu, mem, _) = process_usage(&state);
    let mut out = String::new();
    let _ = writeln!(out, "# HELP blast_uptime_seconds Seconds since the server started.\n# TYPE blast_uptime_seconds counter");
    let _ = writeln!(out, "blast_uptime_seconds {}", state.started.elapsed().as_secs());
    let _ = writeln!(out, "# HELP blast_process_cpu_percent Process CPU use (100 = one core).\n# TYPE blast_process_cpu_percent gauge");
    let _ = writeln!(out, "blast_process_cpu_percent {cpu}");
    let _ = writeln!(out, "# HELP blast_process_memory_bytes Resident memory.\n# TYPE blast_process_memory_bytes gauge");
    let _ = writeln!(out, "blast_process_memory_bytes {}", (mem * 1024.0 * 1024.0) as u64);
    let gauges: [(&str, &str, fn(&ArenaSnapshot) -> f64); 7] = [
        ("blast_players", "Players in the arena, bots included.", |s| s.players as f64),
        ("blast_humans", "Connected human players.", |s| s.humans as f64),
        ("blast_bots", "Server-side bots.", |s| s.bots as f64),
        ("blast_bombs", "Live bombs.", |s| s.bombs as f64),
        ("blast_tick_seconds", "Average simulation tick time.", |s| s.tick_ms / 1000.0),
        ("blast_tick_max_seconds", "Worst simulation tick time.", |s| s.max_tick_ms / 1000.0),
        ("blast_round_seconds_left", "Seconds left in the round.", |s| s.round_secs as f64),
    ];
    let infos = arena_infos(&state);
    for (name, help, get) in gauges {
        let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} gauge");
        for a in &infos {
            let _ = writeln!(out, "{name}{{arena=\"{}\"}} {}", a.name, get(&a.live));
        }
    }
    let counters: [(&str, &str, fn(&ArenaSnapshot) -> u64); 2] = [
        ("blast_bytes_sent_total", "Bytes written to client sockets.", |s| s.bytes_out),
        ("blast_deaths_total", "Players blasted.", |s| s.deaths),
    ];
    for (name, help, get) in counters {
        let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} counter");
        for a in &infos {
            let _ = writeln!(out, "{name}{{arena=\"{}\"}} {}", a.name, get(&a.live));
        }
    }
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], out)
}
