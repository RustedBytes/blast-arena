use bomberman_multiplayer::{game, net};

use axum::Router;
use axum::routing::get;
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
    /// Arena width/height in tiles (forced odd, at least 15).
    #[arg(long, env = "MAP_SIZE", default_value_t = 81)]
    map_size: i32,
    /// Maximum simultaneous players, bots included.
    #[arg(long, env = "MAX_PLAYERS", default_value_t = 256)]
    max_players: usize,
    /// Number of AI bots kept in the arena (0 disables them).
    #[arg(long, env = "BOTS", default_value_t = 10)]
    bots: usize,
    /// Directory with the browser client.
    #[arg(long, env = "STATIC_DIR", default_value = concat!(env!("CARGO_MANIFEST_DIR"), "/static"))]
    static_dir: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_target(false).init();
    let args = Args::parse();

    // The map must be odd-sized so the pillar grid lines up with the border.
    let size = args.map_size.max(15) | 1;
    let cfg = game::Config { map_w: size, map_h: size, max_players: args.max_players, bots: args.bots };

    let (game_tx, game_rx) = mpsc::channel(8192);
    tokio::spawn(game::run(cfg, game_rx));

    let app = Router::new()
        .route("/ws", get(net::ws_handler))
        .fallback_service(ServeDir::new(args.static_dir))
        .with_state(net::AppState { game: game_tx });

    let port = args.port;
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind port");
    tracing::info!("Blast Arena listening on http://localhost:{port}");
    axum::serve(listener, app).await.expect("server error");
}
