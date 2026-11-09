use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::routing::get;
use bomberman_multiplayer::db::Db;
use bomberman_multiplayer::game::{self, Mode};
use bomberman_multiplayer::metrics::ArenaStats;
use bomberman_multiplayer::{api, net};
use clap::Parser;
use tokio::sync::mpsc;
use tower_http::services::ServeDir;

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
    /// Arenas to run, each as NAME:MODE:SIZE:BOTS (mode is ffa or teams).
    /// Repeat the flag for several arenas. Default: a main free-for-all
    /// built from --map-size/--bots, plus "Teams:teams:61:8" and
    /// "Mini:ffa:31:4".
    #[arg(long = "arena", env = "ARENAS", value_delimiter = ',')]
    arenas: Vec<String>,
    /// Round length in seconds.
    #[arg(long, env = "ROUND_SECS", default_value_t = 300)]
    round_secs: u32,
    /// SQLite database for player profiles ("" disables persistence).
    #[arg(long, env = "DB_PATH", default_value = "blast.db")]
    db: String,
    /// Directory with the browser client.
    #[arg(long, env = "STATIC_DIR", default_value = concat!(env!("CARGO_MANIFEST_DIR"), "/static"))]
    static_dir: String,
}

fn parse_arena(spec: &str, base: &game::Config) -> Result<game::Config, String> {
    let parts: Vec<&str> = spec.split(':').collect();
    let [name, mode, size, bots] = parts[..] else {
        return Err(format!("arena {spec:?} must look like NAME:MODE:SIZE:BOTS"));
    };
    let mode = Mode::parse(mode).ok_or_else(|| format!("arena {spec:?}: mode must be ffa or teams"))?;
    let size: i32 = size.parse().map_err(|_| format!("arena {spec:?}: bad size"))?;
    let bots: usize = bots.parse().map_err(|_| format!("arena {spec:?}: bad bot count"))?;
    let size = size.max(15) | 1; // odd, so the pillar grid lines up with the border
    Ok(game::Config { name: name.to_string(), mode, map_w: size, map_h: size, bots, ..base.clone() })
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_target(false).init();
    let args = Args::parse();

    let base = game::Config { max_players: args.max_players, round_secs: args.round_secs.max(30), ..Default::default() };
    let specs = if args.arenas.is_empty() {
        vec![format!("Main:ffa:{}:{}", args.map_size, args.bots), "Teams:teams:61:8".into(), "Mini:ffa:31:4".into()]
    } else {
        args.arenas.clone()
    };
    let configs: Vec<game::Config> = match specs.iter().map(|s| parse_arena(s, &base)).collect() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    let db = if args.db.is_empty() {
        None
    } else {
        match Db::open(&args.db) {
            Ok(db) => Some(db),
            Err(e) => {
                tracing::warn!("profiles disabled, can't open {}: {e}", args.db);
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
    let app = Router::new()
        .route("/ws", get(net::ws_handler))
        .route("/api/arenas", get(api::arenas))
        .route("/api/leaderboard", get(api::leaderboard))
        .route("/api/profile", get(api::profile))
        .route("/api/stats", get(api::stats))
        .route("/metrics", get(api::metrics))
        .fallback_service(ServeDir::new(args.static_dir))
        .with_state(state);

    let port = args.port;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind port");
    tracing::info!("Blast Arena listening on http://localhost:{port}");
    axum::serve(listener, app).await.expect("server error");
}
