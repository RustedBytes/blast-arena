use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::routing::get;
use blast_arena::db::Db;
use blast_arena::game::rng::{derive_seed, random_seed};
use blast_arena::game::{self, Mode};
use blast_arena::metrics::ArenaStats;
use blast_arena::logging::{self, LogFormat};
use blast_arena::{api, net};
use clap::Parser;
use tokio::sync::mpsc;
use tower_http::LatencyUnit;
use tower_http::services::ServeDir;
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

#[cfg(not(debug_assertions))]
mod embedded;

/// Where debug builds serve the client from when `--static-dir` isn't given.
#[cfg(debug_assertions)]
const DEV_STATIC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/static");

/// Blast Arena game server.
#[derive(Parser)]
#[command(version, about)]
struct Args {
    /// HTTP/WebSocket port.
    #[arg(long, env = "PORT", default_value_t = 3000)]
    port: u16,
    /// Main arena width/height in tiles (forced odd, at least 15).
    #[arg(long, env = "MAP_SIZE", default_value_t = 81)]
    map_size: i32,
    /// Maximum simultaneous players per arena, bots included.
    #[arg(long, env = "MAX_PLAYERS", default_value_t = 256)]
    max_players: usize,
    /// AI bots kept in the main arena (0 disables them).
    #[arg(long, env = "BOTS", default_value_t = 10)]
    bots: usize,
    /// Arenas to run, each as NAME:MODE:SIZE:BOTS (mode is ffa, teams,
    /// royale or worms). Repeat the flag for several arenas. Default: a main
    /// free-for-all built from --map-size/--bots, plus "Teams:teams:61:8",
    /// "Mini:ffa:31:4", "Royale:royale:81:15" (battle royale),
    /// "Worms:worms:61:6" (worms hunt everyone) and "Humans:ffa:51:0" (no bots).
    #[arg(long = "arena", env = "ARENAS", value_delimiter = ',')]
    arenas: Vec<String>,
    /// Map seed. Each start picks a fresh one (and logs it) unless this pins
    /// it; the same seed with the same arenas rebuilds the same maps.
    #[arg(long, env = "MAP_SEED")]
    map_seed: Option<u64>,
    /// Round length in seconds.
    #[arg(long, env = "ROUND_SECS", default_value_t = 300)]
    round_secs: u32,
    /// JSON file tuning the ability power-ups (builder, gas bomb, clone,
    /// sticky bomb, portal pair, dash). Fields left out keep their default;
    /// see config/abilities.json for every field.
    #[arg(long, env = "ABILITIES_CONFIG")]
    abilities: Option<String>,
    /// SQLite database for player profiles ("" disables persistence).
    #[arg(long, env = "DB_PATH", default_value = "blast.db")]
    db: String,
    /// Serve the browser client from this directory. Without it, release
    /// builds serve the copy compiled into the binary, and debug builds the
    /// source tree's `static/`.
    #[arg(long, env = "STATIC_DIR")]
    static_dir: Option<String>,
    /// Log filter, e.g. "info" or "`info,blast_arena::net=debug`".
    /// `RUST_LOG`, when set, takes precedence.
    #[arg(long, env = "LOG_LEVEL", default_value = "info")]
    log_level: String,
    /// Log output format.
    #[arg(long, env = "LOG_FORMAT", value_enum, default_value_t = LogFormat::Compact)]
    log_format: LogFormat,
}

fn parse_arena(spec: &str, base: &game::Config) -> Result<game::Config, String> {
    let parts: Vec<&str> = spec.split(':').collect();
    let [name, mode, size, bots] = parts[..] else {
        return Err(format!("arena {spec:?} must look like NAME:MODE:SIZE:BOTS"));
    };
    let mode = Mode::parse(mode).ok_or_else(|| format!("arena {spec:?}: mode must be ffa, teams, royale or worms"))?;
    let size: i32 = size.parse().map_err(|_| format!("arena {spec:?}: bad size"))?;
    let bots: usize = bots.parse().map_err(|_| format!("arena {spec:?}: bad bot count"))?;
    let size = size.max(15) | 1; // odd, so the pillar grid lines up with the border
    Ok(game::Config { name: name.to_string(), mode, map_w: size, map_h: size, bots, ..base.clone() })
}

/// The ability tuning from `--abilities`, or the shipped defaults. Exits on
/// an invalid file rather than running with surprising balance.
fn load_tuning(path: Option<&str>) -> std::sync::Arc<game::ability_config::Tuning> {
    let Some(path) = path else { return game::default_tuning() };
    match game::ability_config::Tuning::load(path) {
        Ok(t) => {
            tracing::info!(path = %path, "ability config loaded");
            std::sync::Arc::new(t)
        }
        Err(e) => {
            tracing::error!(error = %e, "invalid ability config");
            std::process::exit(2);
        }
    }
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    logging::init(&args.log_level, args.log_format);
    tracing::info!(version = env!("CARGO_PKG_VERSION"), log_level = %args.log_level, log_format = %args.log_format, "starting Blast Arena");

    let tuning = load_tuning(args.abilities.as_deref());
    let base = game::Config { max_players: args.max_players, round_secs: args.round_secs.max(30), tuning, ..Default::default() };
    let specs = if args.arenas.is_empty() {
        let main = format!("Main:ffa:{}:{}", args.map_size, args.bots);
        vec![main, "Teams:teams:61:8".into(), "Mini:ffa:31:4".into(), "Royale:royale:81:15".into(), "Worms:worms:61:6".into(), "Humans:ffa:51:0".into()]
    } else {
        args.arenas.clone()
    };
    let map_seed = args.map_seed.unwrap_or_else(random_seed);
    tracing::info!(map_seed, pinned = args.map_seed.is_some(), "map seed (replay this layout with --map-seed {map_seed})");
    let configs: Vec<game::Config> = match specs.iter().map(|s| parse_arena(s, &base)).collect::<Result<Vec<_>, _>>() {
        Ok(mut c) => {
            for (k, cfg) in c.iter_mut().enumerate() {
                cfg.map_seed = derive_seed(map_seed, k as u64);
            }
            c
        }
        Err(e) => {
            tracing::error!(error = %e, "invalid --arena setting");
            std::process::exit(2);
        }
    };
    for c in &configs {
        tracing::info!(arena = %c.name, mode = c.mode.as_str(), size = c.map_w, bots = c.bots, max_players = c.max_players, round_secs = c.round_secs, "arena configured");
    }

    let db = if args.db.is_empty() {
        tracing::warn!("profile persistence disabled (--db \"\")");
        None
    } else {
        match Db::open(&args.db) {
            Ok(db) => Some(db),
            Err(e) => {
                tracing::error!(path = %args.db, error = %e, "can't open profile database; profiles disabled");
                None
            }
        }
    };

    let mut arenas = Vec::new();
    for cfg in configs {
        let (tx, rx) = mpsc::channel(8192);
        let live = Arc::new(ArenaStats::default());
        arenas.push(net::ArenaHandle {
            name: cfg.name.clone(),
            mode: cfg.mode,
            map_size: cfg.map_w,
            max_players: cfg.max_players,
            game: tx,
            live: live.clone(),
        });
        tokio::spawn(game::run(cfg, rx, live, db.clone()));
    }

    let state = net::AppState {
        arenas: Arc::new(arenas),
        db,
        started: Instant::now(),
        sys: Arc::new(std::sync::Mutex::new(sysinfo::System::new().expect("system info available"))),
    };
    let routes = Router::new()
        .route("/ws", get(net::ws_handler))
        .route("/api/arenas", get(api::arenas))
        .route("/api/leaderboard", get(api::leaderboard))
        .route("/api/profile", get(api::profile))
        .route("/api/stats", get(api::stats))
        .route("/metrics", get(api::metrics));
    // The browser client: a directory, or the files built into the binary.
    #[cfg(not(debug_assertions))]
    let (routes, client) = match &args.static_dir {
        Some(dir) => (routes.fallback_service(ServeDir::new(dir)), dir.clone()),
        None => (routes.fallback(embedded::serve), format!("built in ({} files)", embedded::count())),
    };
    #[cfg(debug_assertions)]
    let (routes, client) = {
        let dir = args.static_dir.clone().unwrap_or_else(|| DEV_STATIC_DIR.to_owned());
        (routes.fallback_service(ServeDir::new(&dir)), dir)
    };
    let app = routes
        .with_state(state)
        // One span per HTTP request; visible with RUST_LOG=tower_http=debug.
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(Level::DEBUG))
                .on_response(DefaultOnResponse::new().level(Level::DEBUG).latency_unit(LatencyUnit::Micros)),
        );

    let port = args.port;
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(port, error = %e, "can't bind the port");
            std::process::exit(1);
        }
    };
    tracing::info!(client = %client, "Blast Arena listening on http://localhost:{port}");
    let server = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).with_graceful_shutdown(shutdown_signal());
    if let Err(e) = server.await {
        tracing::error!(error = %e, "server error");
    }
    tracing::info!("server stopped");
}

/// Resolves on Ctrl+C (or SIGTERM on Unix), so the server stops gracefully.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => tracing::info!("Ctrl+C received, shutting down"),
        () = terminate => tracing::info!("SIGTERM received, shutting down"),
    }
}
