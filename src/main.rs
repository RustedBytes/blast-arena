use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use blast_arena::db::Db;
use blast_arena::game::rng::{derive_seed, random_seed};
use blast_arena::game::{self, Mode};
use blast_arena::metrics::ArenaStats;
use blast_arena::logging::{self, LogFormat};
use blast_arena::{api, net, page};
use clap::Parser;
use tokio::sync::mpsc;
use tower_http::LatencyUnit;
use tower_http::services::ServeDir;
use tower_http::trace::{DefaultMakeSpan, DefaultOnResponse, TraceLayer};
use tracing::Level;

#[cfg(not(debug_assertions))]
mod embedded;

// musl builds (the Alpine Docker image): musl's malloc is slow and scales
// poorly across threads (the runtime, its blocking pool, the profile database's thread).
#[cfg(target_env = "musl")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

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
    /// UDP port for WebTransport (HTTP/3), the low-latency transport that
    /// browsers try before the WebSocket. Defaults to --port; 0 turns it off.
    #[arg(long, env = "WT_PORT")]
    wt_port: Option<u16>,
    /// The UDP port browsers should use for WebTransport, when a port
    /// mapping makes it differ from --wt-port (e.g. 443 mapped to 3000).
    #[arg(long, env = "WT_PUBLIC_PORT")]
    wt_public_port: Option<u16>,
    /// PEM certificate chain for WebTransport (with --wt-key), reloaded when
    /// the file changes. Without it, the server makes a short-lived
    /// self-signed certificate, which browsers accept by its hash.
    #[arg(long, env = "WT_CERT", requires = "wt_key")]
    wt_cert: Option<std::path::PathBuf>,
    /// PEM private key for --wt-cert.
    #[arg(long, env = "WT_KEY", requires = "wt_cert")]
    wt_key: Option<std::path::PathBuf>,
    /// Main arena width/height in tiles (forced odd, at least 15).
    #[arg(long, env = "MAP_SIZE", default_value_t = 81)]
    map_size: i32,
    /// Maximum simultaneous players per arena, bots included. An arena with
    /// more bots than this is raised to fit them (humans still get in: a
    /// bot steps out for each).
    #[arg(long, env = "MAX_PLAYERS", default_value_t = 256)]
    max_players: usize,
    /// AI bots kept in the main arena (0 disables them).
    #[arg(long, env = "BOTS", default_value_t = 10)]
    bots: usize,
    /// Arenas to run, each as NAME:MODE:SIZE:BOTS (mode is ffa, teams,
    /// royale, worms, rockets, dungeon or cosmos). Repeat the flag for several arenas.
    /// Default: a main free-for-all built from --map-size/--bots, plus
    /// "Teams:teams:61:8", "Mini:ffa:31:4", "Royale:royale:81:15" (battle
    /// royale), "Worms:worms:61:6" (worms hunt everyone), "Rockets:rockets:51:8"
    /// (the bomb key fires rockets), "Dungeon:dungeon:61:6" (rooms and
    /// corridors full of monsters), "Horde:ffa:321:1000" (a thousand bots),
    /// "Humans:ffa:51:0" (no bots) and "Cosmos:cosmos:51:8" (colored blasters
    /// in space).
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
    /// redb database file for player profiles ("" disables persistence).
    #[arg(long, env = "DB_PATH", default_value = "blast.redb")]
    db: String,
    /// Serve the browser client from this directory. Without it, release
    /// builds serve the copy compiled into the binary, and debug builds the
    /// source tree's `static/`.
    #[arg(long, env = "STATIC_DIR")]
    static_dir: Option<String>,
    /// The site's public address, e.g. "<https://blastarena.fun>", used for
    /// link previews, the canonical link and the sitemap. Without it, the
    /// address is taken from each request (`Host`, or a proxy's
    /// `X-Forwarded-Proto` and `X-Forwarded-Host`).
    #[arg(long, env = "PUBLIC_URL")]
    public_url: Option<String>,
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
    let mode = Mode::parse(mode).ok_or_else(|| format!("arena {spec:?}: mode must be ffa, teams, royale, worms, rockets, dungeon or cosmos"))?;
    let size: i32 = size.parse().map_err(|_| format!("arena {spec:?}: bad size"))?;
    let bots: usize = bots.parse().map_err(|_| format!("arena {spec:?}: bad bot count"))?;
    let size = size.max(15) | 1; // odd, so the pillar grid lines up with the border
    // Room for every bot; a joining human takes a bot's place when it's full.
    let max_players = base.max_players.max(bots);
    Ok(game::Config { name: name.to_string(), mode, map_w: size, map_h: size, bots, max_players, ..base.clone() })
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

// A worker thread per CPU core (`TOKIO_WORKER_THREADS` sets another
// count), so the arenas tick in parallel: a slow tick in a big arena no
// longer holds up the others, the sockets or the HTTP handlers. Each
// worker costs some memory (its own allocator caches and scheduler queue).
// Blocking work (`tokio::fs`) goes to tokio's blocking pool.
#[tokio::main]
async fn main() {
    let args = Args::parse();
    logging::init(&args.log_level, args.log_format);
    let public_url = checked_public_url(args.public_url.as_deref());
    tracing::info!(version = env!("CARGO_PKG_VERSION"), log_level = %args.log_level, log_format = %args.log_format, "starting Blast Arena");

    let tuning = load_tuning(args.abilities.as_deref());
    let base = game::Config { max_players: args.max_players, round_secs: args.round_secs.max(30), tuning, ..Default::default() };
    let specs = if args.arenas.is_empty() {
        let main = format!("Main:ffa:{}:{}", args.map_size, args.bots);
        vec![
            main,
            "Teams:teams:61:8".into(),
            "Mini:ffa:31:4".into(),
            "Royale:royale:81:15".into(),
            "Worms:worms:61:6".into(),
            "Rockets:rockets:51:8".into(),
            // Rooms and corridors, haunted by monsters.
            "Dungeon:dungeon:61:6".into(),
            // A thousand bots, with about 100 cells each to play in.
            "Horde:ffa:321:1000".into(),
            "Humans:ffa:51:0".into(),
            // Last, so the arenas before it keep their ids (saved picks, invite links).
            // Colored blasters on a space station.
            "Cosmos:cosmos:51:8".into(),
        ]
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

    let state = net::AppState {
        arenas: Arc::new(spawn_arenas(configs, db.as_ref())),
        db,
        started: Instant::now(),
        sys: Arc::new(std::sync::Mutex::new(sysinfo::System::new().expect("system info available"))),
        webtransport: Arc::new(std::sync::RwLock::new(None)),
    };
    start_webtransport(&args, &state, public_url.as_deref()).await;
    let routes = Router::new()
        .route("/ws", get(net::ws_handler))
        .route("/api/arenas", get(api::arenas))
        .route("/api/leaderboard", get(api::leaderboard))
        .route("/api/profile", get(api::profile))
        .route("/api/stats", get(api::stats))
        .route("/api/transport", get(api::transport))
        .route("/metrics", get(api::metrics));
    let routes = site_routes(routes, &args, public_url);
    // The rest of the browser client: a directory, or the files built into the binary.
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

/// Built without the `webtransport` feature: clients use the WebSocket.
#[cfg(not(feature = "webtransport"))]
#[allow(clippy::unused_async, reason = "same signature as the real one")]
async fn start_webtransport(args: &Args, _state: &net::AppState, _public_url: Option<&str>) {
    if args.wt_port.is_some_and(|p| p != 0) || args.wt_cert.is_some() {
        tracing::warn!("built without the webtransport feature; --wt-* settings are ignored");
    }
}

/// Starts each arena's game task and returns the handles sessions join through.
fn spawn_arenas(configs: Vec<game::Config>, db: Option<&Db>) -> Vec<net::ArenaHandle> {
    configs
        .into_iter()
        .map(|cfg| {
            let (tx, rx) = mpsc::channel(8192);
            let live = Arc::new(ArenaStats::default());
            let handle = net::ArenaHandle {
                name: cfg.name.clone(),
                mode: cfg.mode,
                map_size: cfg.map_w,
                max_players: cfg.max_players,
                game: tx,
                live: live.clone(),
            };
            tokio::spawn(game::run(cfg, rx, live, db.cloned()));
            handle
        })
        .collect()
}

/// Starts the WebTransport endpoint unless `--wt-port 0`; clients fall
/// back to the WebSocket when it's off or fails to start.
#[cfg(feature = "webtransport")]
async fn start_webtransport(args: &Args, state: &net::AppState, public_url: Option<&str>) {
    use blast_arena::wt;
    let port = args.wt_port.unwrap_or(args.port);
    if port == 0 {
        tracing::info!("WebTransport off (--wt-port 0); clients use the WebSocket");
        return;
    }
    let settings = wt::Settings {
        port,
        public_port: args.wt_public_port,
        cert: args.wt_cert.clone().zip(args.wt_key.clone()),
        names: public_url.and_then(page::host_of).into_iter().collect(),
    };
    let info = wt::start(settings, state.clone()).await;
    *state.webtransport.write().unwrap_or_else(std::sync::PoisonError::into_inner) = info;
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

/// `--public-url`, checked; exits on an invalid one.
fn checked_public_url(url: Option<&str>) -> Option<String> {
    match url.filter(|u| !u.trim().is_empty()).map(page::public_url) {
        None => None,
        Some(Ok(url)) => Some(url),
        Some(Err(e)) => {
            tracing::error!(error = %e, "invalid --public-url");
            std::process::exit(2);
        }
    }
}

/// The game page (with this site's address filled in), robots.txt and the sitemap.
fn site_routes(routes: Router<net::AppState>, args: &Args, public_url: Option<String>) -> Router<net::AppState> {
    #[cfg(not(debug_assertions))]
    let index = match &args.static_dir {
        Some(dir) => IndexSource::Dir(dir.into()),
        None => IndexSource::Embedded(embedded::file("index.html").expect("index.html is embedded")),
    };
    #[cfg(debug_assertions)]
    let index = IndexSource::Dir(args.static_dir.clone().unwrap_or_else(|| DEV_STATIC_DIR.to_owned()).into());
    let site = Arc::new(Site { index, public_url });
    routes
        .route("/", get(index_page).with_state(site.clone()))
        .route("/index.html", get(index_page).with_state(site.clone()))
        .route("/robots.txt", get(robots_txt).with_state(site.clone()))
        .route("/sitemap.xml", get(sitemap_xml).with_state(site))
}

/// Where `index.html` comes from: the binary, or a directory (read on each
/// request, so edits show up on reload).
enum IndexSource {
    #[cfg_attr(debug_assertions, allow(dead_code))]
    Embedded(&'static [u8]),
    Dir(std::path::PathBuf),
}

struct Site {
    index: IndexSource,
    public_url: Option<String>,
}

type SiteState = axum::extract::State<Arc<Site>>;

async fn index_page(axum::extract::State(site): SiteState, headers: HeaderMap) -> Response {
    let html = match &site.index {
        IndexSource::Embedded(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        IndexSource::Dir(dir) => match tokio::fs::read_to_string(dir.join("index.html")).await {
            Ok(html) => html,
            Err(_) => return (StatusCode::NOT_FOUND, "not found").into_response(),
        },
    };
    let body = page::render(&html, &page::origin(&headers, site.public_url.as_deref()));
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-cache")], body).into_response()
}

async fn robots_txt(axum::extract::State(site): SiteState, headers: HeaderMap) -> Response {
    let body = page::robots(&page::origin(&headers, site.public_url.as_deref()));
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response()
}

async fn sitemap_xml(axum::extract::State(site): SiteState, headers: HeaderMap) -> Response {
    let body = page::sitemap(&page::origin(&headers, site.public_url.as_deref()));
    ([(header::CONTENT_TYPE, "application/xml; charset=utf-8")], body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arena_spec_raises_the_player_cap_to_fit_its_bots() {
        let base = game::Config { max_players: 256, ..Default::default() };
        let horde = parse_arena("Horde:ffa:321:1000", &base).unwrap();
        assert_eq!((horde.map_w, horde.bots, horde.max_players), (321, 1000, 1000));
        let mini = parse_arena("Mini:ffa:31:4", &base).unwrap();
        assert_eq!(mini.max_players, 256, "small arenas keep the configured cap");
    }
}
