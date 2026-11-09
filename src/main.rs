mod game;
mod net;
mod protocol;

use axum::Router;
use axum::routing::get;
use tokio::sync::mpsc;
use tower_http::services::ServeDir;

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_target(false).init();

    let port: u16 = env_or("PORT", 3000);
    // The map must be odd-sized so the pillar grid lines up with the border.
    let size = env_or("MAP_SIZE", 81i32).max(15) | 1;
    let cfg = game::Config { map_w: size, map_h: size, max_players: env_or("MAX_PLAYERS", 256usize) };
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/static").into());

    let (game_tx, game_rx) = mpsc::channel(8192);
    tokio::spawn(game::run(cfg, game_rx));

    let app = Router::new()
        .route("/ws", get(net::ws_handler))
        .fallback_service(ServeDir::new(static_dir))
        .with_state(net::AppState { game: game_tx });

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind port");
    tracing::info!("Blast Arena listening on http://localhost:{port}");
    axum::serve(listener, app).await.expect("server error");
}
