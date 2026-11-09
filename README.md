# Blast Arena

A massively multiplayer bomb-maze game for the browser. Everyone plays in one huge shared arena: drop bombs, blast crates, collect power-ups and blast each other.
- **Server:** Rust (Axum + WebSocket).
- **Client:** plain HTML5 canvas with hand-made SVG art and procedural chiptune music. There are no audio files.

## Run

```bash
cargo run --release
```

Open http://localhost:3000, enter a nickname and play.

### Keyboard

| Key | Action |
|---|---|
| WASD / arrow keys | Move. Hold a second direction to queue a turn: hold Right, press Up early, and you turn at the next gap. |
| Space / Enter | Drop a bomb |
| Mouse wheel, `+` / `-` / `0` | Zoom in / out / reset |
| Tab (hold) | Leaderboard with kills and deaths |
| M | Mute |
| F | Show or hide FPS |
| Esc | Settings |

### Other controls
- **Gamepad:** the stick or d-pad moves, A/B drops a bomb, and the shoulder buttons zoom.
- **Touch:** drag anywhere on the left to steer with a floating joystick, tap the bomb button, and pinch to zoom.

### Settings
The settings menu has music volume, sound effects volume, zoom, mute and FPS. They're remembered per browser.

Configuration is through command-line arguments, each with an environment-variable fallback. `cargo run --release -- --help` lists them.

| Argument        | Env var       | Default    | Meaning                                         |
|-----------------|---------------|------------|-------------------------------------------------|
| `--port`        | `PORT`        | `3000`     | HTTP/WebSocket port                             |
| `--map-size`    | `MAP_SIZE`    | `81`       | Arena width/height in tiles (forced odd, ≥15)   |
| `--max-players` | `MAX_PLAYERS` | `256`      | Player cap, bots included                       |
| `--bots`        | `BOTS`        | `10`       | AI bots kept in the arena; `0` turns them off   |
| `--static-dir`  | `STATIC_DIR`  | `./static` | Client files                                    |

For example, to start a small arena with 6 bots:

```bash
cargo run --release -- --map-size 21 --bots 6
```

## AI bots

The server runs its own bots so the arena is never empty. They show up as regular players named like "Sparky [bot]". Each bot is an ordinary player without a connection, so it follows exactly the same rules as humans.

How a bot thinks:
- **Danger map.** Every tick, the bots share a map of how many ticks remain before fire reaches each cell. It accounts for chain reactions, where one bomb sets off another.
- **Priorities.** A bot always escapes danger first. After that it goes for the best target nearby: a power-up, a spot where a bomb would hit an enemy, or a spot where a bomb would blow up the most crates. If there's nothing in reach, it wanders off to explore.
- **Safe bombing.** A bot drops a bomb only after simulating the blast and finding a way out before the fuse burns down. It also avoids escape routes through cells where other players stand, and wants either two separate exits or a roomy safe area. That way another player can't seal off its only escape.
- **Last resort.** If a bot is trapped anyway, it moves to the cell that will catch fire last, or tries to kick its way out.
- **Mistakes.** Each bot has a small random chance to drop a risky bomb when attacking, so they stay beatable.

Bots make room for humans. When the server is full, a joining player replaces a bot. Bots refill up to `--bots` whenever there's space again.

## Benchmarks

### Load test

With the server running:

```bash
cargo run --release --bin bots -- --count 150
```

This is a separate binary that opens real WebSocket connections that wander at random, to stress the network side. Use `--url` to point it at another server and `--secs` to stop it after a set time. It prints message rate, bandwidth per bot, ping round-trip and disconnects every 5 s. The server logs its average and worst tick time every 10 s.

### Simulation benchmark

```bash
cargo run --release --bin simbench
```

This runs the world in-process with 200 bots and 150 simulated clients. Their snapshots are really encoded and then drained. It reports the tick time and the **heap allocations per tick**, counted by a wrapper around the global allocator.

A typical run:

| Measure | Result |
|---|---|
| Tick time | about 2 ms on average, budget 50 ms |
| Allocations | about 0.07 per tick |
| Ticks with no allocation at all | 94% |

## How it scales

- **Compact binary protocol.** Messages are MessagePack over binary WebSocket frames.
  - Hot messages are written by hand straight into a reusable buffer.
  - Client messages are parsed in place, without allocating.
  - The browser side uses a small codec in `static/js/msgpack.js`.
- **Zero-copy, zero-allocation ticks.**
  - **Encoding.** Snapshots are encoded into a ring of large arenas. Each client's message is a reference-counted slice of the arena, handed to the socket without copying. An arena is reused in place once its messages have been sent.
  - **No per-tick allocation.** The simulation and the bots work in persistent scratch buffers. Path searches use generation-stamped visit marks, so they never need clearing.
- **Lock-free input.** Each connection writes its newest input (directions, bomb presses, view size) into a small set of atomics, and the game reads it once per tick. Input needs no queue and builds no backlog.
- **One authoritative simulation task.** It owns the whole world and runs at 20 ticks/s with no locks.
- **Area of interest.**
  - Each client gets only the players, bombs, flames and items near it, found through an 8×8-tile spatial grid.
  - The default area is ±16×12 tiles. When a client zooms, it asks for its view size, and the server grants up to ±26×18.
  - Tile changes go to everyone, so each client's map copy stays correct.
- **Back-pressure without punishing lag.**
  - Snapshots go through a one-slot mailbox, so a client that falls behind simply skips stale ones.
  - Only an overflowing reliable-event queue (256 messages) disconnects a client.
- **Client.**
  - Static tiles are cached in chunk canvases that are redrawn only when a tile changes.
  - Snapshots live in a fixed ring buffer.
  - Particles come from a preallocated typed-array pool.
  - The per-frame render path creates no garbage.
  - An FPS / frame-time widget shows the result.

## Game rules

- Bombs explode in a cross after 2.5 s. Pillars stop the blast. A crate absorbs it and is destroyed. Blasts set off other bombs in chain reactions.
- Destroyed crates drop a power-up 25% of the time:

  | Power-up | Effect |
  |---|---|
  | +bomb | One more bomb at a time |
  | +range | Longer blast |
  | speed | Move faster |
  | kick | Walk into a bomb to send it sliding |
  | shield | 6 s of invulnerability |
  | pierce | Your blasts go through crates |
  | full fire | Maximum range |
  | **secret box** | A random outcome when opened (see below) |

- **Secret box.** Walk onto it to open it. It contains one of:
  - any power-up
  - a jackpot: +1 bomb, +1 range and +1 speed
  - a curse: 8 s slowed down, or 6 s with no bombs

  Secret boxes also appear on their own around the arena.
- If bombs box you in and every other way out is blocked, you can kick an adjacent bomb even without the kick power-up, so you're never stuck waiting to explode.
- Corner assist eases you into corridors when you're slightly off-line. You can walk off a bomb you just dropped, but not back onto it.
- **Dying:**
  - You lose your power-ups, and a few of them are scattered nearby.
  - You respawn after 3 s with 2 s of spawn protection.
- **Scoring:** a kill gives the bomb's owner +1. Blowing yourself up costs 1 point.
- Crates slowly regrow in quiet areas so the big arena never runs dry.

## Layout

```
src/main.rs          server entry point, command-line config
src/lib.rs           library root (game, net, protocol)
src/net.rs           WebSocket sessions (handshake, reader/writer, rate limit)
src/protocol.rs      MessagePack wire format, hand-rolled encoder, arena ring
src/game/            simulation: map, player movement, bombs, items, AOI
src/game/link.rs     lock-free input slot and snapshot mailbox per client
src/game/ai.rs       server-side AI bots
src/bin/bots.rs      network load tester
src/bin/simbench.rs  tick-time and allocation benchmark
static/              client: index.html, style.css, SVG art in assets/
static/js/           main, render, particles, input, audio, settings, net, msgpack
```
