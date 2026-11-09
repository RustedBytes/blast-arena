# Blast Arena

A massively multiplayer bomb-maze game for the browser. Everyone plays in one huge shared arena: drop bombs, blast crates, collect power-ups and blast each other. The server is Rust (Axum + WebSocket); the client is plain HTML5 canvas with hand-made SVG art.

## Run

```bash
cargo run --release
```

Open http://localhost:3000, enter a nickname and play.

Controls:
- Move: WASD or the arrow keys
- Drop a bomb: Space
- On touch screens: on-screen d-pad and bomb button

Configuration is through environment variables:

| Variable      | Default    | Meaning                                       |
|---------------|------------|-----------------------------------------------|
| `PORT`        | `3000`     | HTTP/WebSocket port                           |
| `MAP_SIZE`    | `81`       | Arena width/height in tiles (forced odd, ≥15) |
| `MAX_PLAYERS` | `256`      | Connection cap                                |
| `STATIC_DIR`  | `./static` | Client files                                  |

## Load test

With the server running:

```bash
cargo run --release --bin bots -- --count 150
```

It prints message rate, bandwidth per bot, ping round-trip and disconnects every 5 s. The server logs its average and worst tick time every 10 s.

## How it scales

- **Compact binary protocol.** Messages are MessagePack over binary WebSocket frames (`rmp-serde` on the server, a small codec in `static/js/msgpack.js` on the client).
- **One authoritative simulation task.** It owns the whole world and runs at 20 ticks/s with no locks. Connections send it input over a channel.
- **Area of interest.** Each client gets only the players, bombs, flames and items within ±16×12 tiles of itself, found through an 8×8-tile spatial grid. The client sizes its tiles so the screen never shows more than that box. Tile changes, such as a crate destroyed or regrown, are small and go to everyone so each client's map copy stays correct.
- **Back-pressure.** Each client has a bounded outgoing queue (64 messages). A client that can't keep up is disconnected instead of slowing the world for everyone else.

## Game rules

- Bombs explode in a cross after 2.5 s. Pillars stop the blast. A crate absorbs it and is destroyed. Blasts set off other bombs in chain reactions.
- Destroyed crates drop power-ups 25% of the time: **+bomb**, **+range**, **+speed** and **kick** (walk into a bomb to send it sliding).
- If bombs box you in and every other way out is blocked, you can kick an adjacent bomb even without the kick power-up, so you're never stuck waiting to explode.
- Corner assist eases you into corridors when you're slightly off-line. You can walk off a bomb you just dropped, but not back onto it.
- **Dying:**
  - You lose your power-ups, and a few of them are scattered nearby.
  - You respawn after 3 s with 2 s of spawn protection.
- **Scoring:** a kill gives the bomb's owner +1. Blowing yourself up costs 1 point.
- Crates slowly regrow in quiet areas so the big arena never runs dry.

## Layout

```
src/main.rs          router, config
src/net.rs           WebSocket sessions (handshake, reader/writer, rate limit)
src/protocol.rs      MessagePack wire format
src/game/            simulation: map, player movement, bombs, items, AOI
src/bin/bots.rs      load-testing bot swarm
static/              client (index.html, js/, style.css) and SVG art in assets/
```
