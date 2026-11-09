# Blast Arena

<img src="./screenshots/1.png" alt="Screenshot 1">
<img src="./screenshots/2.png" alt="Screenshot 1">
<img src="./screenshots/3.png" alt="Screenshot 1">

A massively multiplayer bomb-maze game for the browser. Pick an arena, drop bombs, blast crates, grab power-ups, hold the hills and blast each other.

- **Server:** Rust (Axum + WebSocket). Several arenas run side by side, with smart AI bots, rounds, teams and persistent player profiles in SQLite.
- **Client:** plain HTML5 canvas with pixel art generated in code (or the classic hand-made SVG art) and procedural chiptune music (no audio files), in English, Ukrainian and Russian. The language follows your browser and can be changed in the lobby or settings.

## Run

```bash
cargo run --release
```

Open http://localhost:3000, pick an arena, enter a nickname and play.

The live server dashboard is at http://localhost:3000/dashboard.html, and Prometheus metrics at `/metrics`.

### Controls

| Input | Action |
|---|---|
| WASD / arrow keys | Move. Hold a second direction to queue a turn: hold Right, press Up early, and you turn at the next gap. |
| Space / Enter | Drop a bomb. Press again while standing on it with the line bomb to lay a row. |
| E / Shift | Action: detonate remote bombs, or punch the bomb in front of you |
| 1–8 | Emotes (also the 😀 button) |
| Mouse wheel, `+` / `-` / `0` | Zoom in / out / reset |
| Tab (hold) | Leaderboard with kills and deaths |
| M / F / Esc | Mute / FPS / settings |
| Gamepad | Stick or d-pad moves, A bomb, X action, shoulder buttons zoom |
| Touch | Drag on the left to steer (floating joystick), bomb and action buttons, pinch to zoom |

The settings menu has music and sound volume, zoom, language, **art style**, mute, FPS, a colour-blind-friendly palette, high contrast, and a button to replay the tutorial. Art style is **Pixel art** by default: crisp 16×16 graphics generated in code, tiles in `static/js/pixelart.js` and sprites in `static/js/pixelsprites.js`, sharing `static/js/pixelkit.js`. **Classic** brings back the original vector art. A short interactive tutorial runs on your first game.

The pixel art follows a few rules:
- **Lighting:** one light source from the top left, and colour ramps that shift hue (cool shadows, warm highlights).
- **Floors:** quiet and seamless, with variants per region, so players and items stand out.
- **Walls and crates:** raised blocks in 3/4 view, casting soft shadows onto the floor.
- **Regions:** each has its own walls (mossy stone, snow-capped blocks with icicles, limestone with gold inlays, obsidian with lava veins), and neighbouring regions blend along a wavy border.
- **Sprites:** everything you interact with has a dark outline.
  - **Bombs:** shaded iron spheres with a glint and a ground shadow. Pierce bombs are red with spikes, and remote bombs get a blinking antenna.
  - **Fire:** a fireball with white-hot, yellow, orange and red bands, flickering through three frames.
  - **Power-ups:** one family of bevelled tokens. The frame colour shows rarity and the glyph shows the effect.
  - **Players:** helmeted bombers in their team or player colour, with walk frames and pixel hats.
  - **Particles:** in pixel style they snap to the same pixel grid.

The **Tile Lab** at http://localhost:3000/tiles.html has three parts:
- a live scene animated by the game's renderer: walking players with hats, all three bomb types, a flickering explosion and power-ups
- a sample map of all four regions
- a sheet of every generated tile and sprite

You can reroll the tile seed there and compare with the classic art.

## Configuration

Command-line arguments; each has an environment-variable fallback. `cargo run --release -- --help` lists them.

| Argument | Env var | Default | Meaning |
|---|---|---|---|
| `--port` | `PORT` | `3000` | HTTP/WebSocket port |
| `--arena` | `ARENAS` | see below | An arena as `NAME:MODE:SIZE:BOTS`, mode `ffa` or `teams`. Repeat the flag, or comma-separate in the env var. |
| `--map-size` | `MAP_SIZE` | `81` | Size of the default main arena |
| `--bots` | `BOTS` | `10` | Bots in the default main arena |
| `--max-players` | `MAX_PLAYERS` | `256` | Player cap per arena, bots included |
| `--round-secs` | `ROUND_SECS` | `300` | Round length |
| `--db` | `DB_PATH` | `blast.db` | SQLite file for profiles; `""` disables them |
| `--static-dir` | `STATIC_DIR` | `./static` | Client files |
| `--log-level` | `LOG_LEVEL` | `info` | Log filter, e.g. `debug` or `info,blast_arena::net=debug`. `RUST_LOG` overrides it. |
| `--log-format` | `LOG_FORMAT` | `compact` | `compact`, `pretty`, or `json` (one object per line, for log collectors) |

Without `--arena` the server runs three arenas:
- `Main:ffa:<map-size>:<bots>`
- `Teams:teams:61:8`
- `Mini:ffa:31:4`

### Logging

The server logs with `tracing`. Records from the `log` crate are bridged into the same output, and the profile database logs that way.

| Level | Events |
|---|---|
| info | Startup and arena config; each player's join and disconnect, with the reason, duration and message counts; reconnects that resume a parked player; round results; tick stats every 10 s; shutdown |
| warn | Rate-limited or too-slow clients; dropped profile saves |
| debug | Handshake failures, socket errors, bot top-ups, profile loads and saves, and HTTP requests with their latency (`tower_http=debug`) |

Each session's lines carry a span with the arena, the peer address and the player id. Each game line carries its arena. Profile tokens are never logged.

```bash
RUST_LOG=info,blast_arena=debug cargo run --release -- --log-format json
```

## Gameplay

- **Bombs** explode in a cross after 2.5 s. Pillars stop the blast. Crates absorb it and break. Blasts set off other bombs in chain reactions.
- **Map regions** (on maps of 41×41 and up), each with its own look:

  | Region | Feature |
  |---|---|
  | Snow | Ice: let go and you keep sliding until you steer, hit something or leave the ice |
  | Desert | Conveyor belts that carry players and bombs |
  | Volcano | Armored crates that take two blasts |
  | Grass | Normal arena |

  Linked teleporter pads connect distant parts of the map.
- **Power-ups**, revealed from 25% of crates:

  | Power-up | Effect |
  |---|---|
  | +bomb | One more bomb at a time |
  | +range | Longer blast |
  | speed | Move faster |
  | kick | Walk into a bomb to send it sliding |
  | shield | 6 s of invulnerability |
  | pierce | Your blasts go through crates |
  | full fire | Maximum range |
  | remote | Your bombs wait for E (or 10 s) |
  | line bomb | Lay a row of bombs |
  | punch | Throw a bomb over obstacles |
  | ghost | Walk through crates for 6 s |
  | **secret box** | A random outcome when opened (see below) |

- **Secret box.** Opening it gives one of:
  - any power-up
  - a jackpot: +1 bomb, +1 range and +1 speed
  - a curse: slowed down, no bombs, or reversed controls
  - bomb rain around you

  Secret boxes also appear on their own around the map.
- **Rounds** last 5 minutes. At the end, the MVPs and the winning team are shown, the MVP's profile gets a win and bonus XP, and scores reset.
- **Scoring:**
  - +1 per kill.
  - +1 every 3 s you stand on a glowing **hill**; hills move each round.
  - The leader (5+ points) carries a **bounty** worth +2 extra.
  - Streaks of 3, 5, 8 and 12 kills are announced to everyone.
  - Blowing yourself up costs 1 point.
- **Team mode:** red versus blue, with balanced teams and no friendly fire.
- **Dying:**
  - You drop some power-ups.
  - While you wait 3 s to respawn, the camera follows whoever got you.
  - You come back with 2 s of spawn protection.
- If bombs box you in, you can kick one even without the kick power-up.

## Profiles, cosmetics, friends

- **Profiles:**
  - Your browser keeps a random profile token, with no sign-up. Kills, deaths, MVP wins, best streak and XP are saved in SQLite.
  - The lobby shows your level and an all-time top 20.
- **Cosmetics:** hats (cap, party hat, horns, halo, crown, top hat) and trails (gold, ice, rainbow) unlock as you level up.
- **Invites:** the 🔗 button copies an invite link (`?arena=…&near=<your id>`). Friends who open it spawn next to you.
- **Reconnecting:** a dropped connection reconnects automatically. The server keeps your score and power-ups for 30 s.

## AI bots

Each arena keeps its bots topped up, and humans take a bot's place when an arena is full. Bots follow the same rules as players.

How a bot plays:
- **Danger map.** The bots share a map of how many ticks remain before fire reaches each cell. It covers chain reactions and treats remote bombs as live.
- **Priorities:** escape first, then power-ups, attack spots, crate spots, or wandering. In team mode they don't target teammates.
- **Safe bombing.** A bot drops a bomb only with a robust way out. It avoids cells where others stand, and needs either two exits or a roomy safe area. It never chooses ice, a conveyor or a teleporter as a place to stop.
- **Remote bombs.** Once safe, a bot detonates its remote bombs.

## Deploy

```bash
DOMAIN=play.example.com docker compose up -d
```

- `Dockerfile` builds a small runtime image.
- `docker-compose.yml` puts it behind **Caddy**, which gets a TLS certificate automatically, so the game uses `wss://`.
- Profiles live in the `blast-data` volume.
- Caddy hides `/metrics` from the internet. Scrape `http://game:3000/metrics` from the Docker network instead.

Tested with Docker 29 and `docker-compose` 1.29 (in WSL), running `DOMAIN=localhost docker-compose up -d --build`:
- The image builds, and the server starts all arenas as a non-root user.
- Caddy serves the page and API over HTTPS, and redirects plain HTTP to HTTPS (308).
- The WebSocket upgrade over `wss://` returns 101.
- `/metrics` returns 404 from outside but works inside the Docker network.
- The profile database is written to the `blast-data` volume.

## Benchmarks

```bash
# Network load test: real WebSocket clients wandering at random.
cargo run --release --bin bots -- --count 150

# In-process simulation: tick time and heap allocations per tick.
cargo run --release --bin simbench
```

Results on this machine:

| Measure | Result |
|---|---|
| Server tick, 200 bots + 150 clients encoding real snapshots (simbench) | about 3.4 ms (budget 50 ms) |
| Heap allocations per tick | about 0.06; 94% of ticks allocate nothing |
| Snapshot size per client per tick (simbench) | 383 bytes, down from 530 before delta encoding |
| Bandwidth per client, 150 connections (load test) | about 5.1 KB/s |
| Disconnects in the load test | 0 |

Prediction was also tested in the browser with every message delayed by 100 ms each way (212 ms ping):

| Measure | Result |
|---|---|
| First local movement after a key press | 14 ms |
| Prediction error over 171 reconciliations while turning constantly | 0.001 tiles on average, 0.005 at most |
| Corrections larger than a quarter tile | none |

Open the game with `?debug` to get `window.__blast` (state, predictor stats, network) in the browser console.

## How it scales

- **Several arenas.** Each arena is its own simulation task with its own bots. The lobby lists them with live player counts.
- **Compact binary protocol.**
  - Messages are MessagePack over binary WebSocket frames.
  - Hot messages are written by hand straight into reusable buffers.
  - Client messages are parsed in place, without allocating.
- **Delta snapshots.**
  - Every input message also says which snapshot the client last decoded.
  - The server keeps a short history (32 ticks) of what it sent each client. It encodes only the players and bombs that are new, moved or gone since the snapshot the client confirmed.
  - If that snapshot is too old or unknown, a full snapshot goes out instead. This happens, for example, right after joining.
  - Bombs carry their absolute detonation tick, so a resting bomb never counts as changed.
  - Tiles and items are sent once on join. After that only their changes go out, in a reliable world-delta stream. A skipped snapshot can't lose them.
- **Client-side prediction.**
  - Your browser runs the same movement code as the server, so your own moves show up instantly.
  - Each input carries a sequence number, and snapshots echo the last one the server applied.
  - The client then replays only the inputs the server hasn't seen yet.
- **Zero-copy, zero-allocation ticks.**
  - **Encoding.** Snapshots are encoded into a ring of large reusable buffers. Each client's message is a reference-counted slice handed to the socket without copying.
  - **No per-tick allocation.** The simulation and the bots work in persistent scratch memory, and their path searches never need clearing between uses.
- **Lock-free input.** Each connection writes its newest input into a few atomic counters that the game reads once per tick. There is no queue.
- **Area of interest.** Clients get entities within ±16×12 tiles by default. A client that zooms out can request up to ±26×18.
- **Back-pressure.**
  - A client that falls behind skips stale snapshots instead of building up a queue.
  - Only a client whose queue of important messages (kills, joins and the like) overflows is disconnected.
- **Client.**
  - Static tiles are cached in canvas chunks, redrawn only when a tile changes.
  - Snapshots live in a fixed-size ring buffer.
  - Effects use a preallocated particle pool.
  - An FPS / frame-time widget shows the result: 100–165 FPS at about 1 ms of work per frame in testing.

## Layout

```
src/main.rs           server entry point: arenas, routes, config
src/lib.rs            library root (crate blast_arena)
src/logging.rs        tracing subscriber setup and the log-crate bridge
src/net.rs            WebSocket sessions (arena choice, profile load, reader/writer)
src/api.rs            /api/arenas, /api/leaderboard, /api/profile, /api/stats, /metrics
src/db.rs             SQLite profiles, levels and cosmetic unlocks
src/metrics.rs        lock-free per-arena live stats
src/protocol.rs       MessagePack wire format, hand-rolled encoder, arena ring
src/game/mod.rs       World state, config and constants
src/game/             tick (loop), roster (join/leave/spawn), movement, input, combat,
                      pickups, terrain, rounds, profiles, snapshot (AOI, encoding),
                      delta (delta snapshots), map, bomb, items, player, testing, tests
src/game/link.rs      lock-free input slot and snapshot mailbox per client
src/game/ai.rs        server-side AI bots
src/bin/bots.rs       network load tester
src/bin/simbench.rs   tick-time and allocation benchmark
static/index.html     lobby and game page; dashboard.html is the server monitor;
                      tiles.html is the Tile Lab
static/js/            main, render, prediction, particles, input, audio, i18n,
                      tutorial, settings, net, msgpack, dashboard
static/assets/        SVG art
Dockerfile, docker-compose.yml, Caddyfile   deployment
```
