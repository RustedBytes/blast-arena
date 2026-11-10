# Changelog

All notable changes to Blast Arena are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Players walk more naturally: the stride follows the ground actually
  covered (no feet sliding at high speed), the gait eases in and out,
  bodies lean into sideways runs and settle when they stop, and footsteps
  kick up dust. Pixel art keeps its grid: no lean or squash.
- The interface fits more screens:
  - Phones held upright: the round timer gets the top line, and the stats
    and leaderboard sit under it instead of on top of each other.
  - Phones in landscape: a compact HUD, a three-player leaderboard, a
    lower and tighter cluster of touch buttons that no longer hides under
    the leaderboard, and the FPS panel at the bottom.
  - Tablets and narrow windows: the stats wrap before reaching the timer,
    and alerts fit between the side panels.
  - Large displays: the HUD and menus scale up (1.2× from about 1700×950,
    1.4× from 2200×1250, 1.8× from 3000×1700).
  - Notches and rounded corners are kept clear (safe areas), and phone
    browser bars no longer cut off the lobby or joystick area.
  - On touch screens the lobby hides the keyboard key list, and fields no
    longer zoom the page when focused.

- **Worms hunt cleverly** (tuning in `WormTuning`):
  - they make for where a running player is going, not where they are,
    and wait in ambush where they'll get there first;
  - two worms after the same player split up to come from different sides;
  - prey a step or two away gets a lunge, faster than a player runs;
  - when prey slips out of range, a worm keeps searching where it was last
    smelt for a few seconds;
  - idle worms drift towards the nearest player instead of only wandering;
  - worms see blasts coming (chain reactions and nukes included) and keep
    their whole body out of them.
  In a 15 bot-minute simulation, worms now catch 48 players (2 before)
  and get blown up more often (102 against 77), as they're where the action is.
- **Worm spawning**: new worms burrow out near players (within 18 cells,
  never within 7), away from other worms, on lanes with a way out, and
  never in a nuke's zone; they take 1.5 s to come out (was 1 s).
- **Worm looks**: a pointed tail, a paler saddle band, outlined
  segments, shadows, and jaws that open wider as a worm hunts and gape
  when it lunges, with glowing eyes. Hunters kick up dirt. A burrowing
  worm shows a red warning ring that tightens as it gets ready, cracks in
  the ground and flying clods.
- Snapshots carry two more worm flags (8 lunging, 16 lying in wait), and an
  emerging worm's step is the length of its emergence.

### Fixed

- On phones, the top of the lobby (logo, name and language) was pushed out
  of reach of scrolling.

## [0.6.1] - 2026-11-10

### Fixed

- Small position jumps after letting go of the movement keys. The server
  now walks a player once per input step the client sends (as the
  client's prediction does) instead of once per tick with the newest
  input, so network jitter no longer leaves it a step ahead or behind
  when you stop. Bunched-up inputs are caught up on later, at no more than
  one step per tick on average.

## [0.6.0] - 2026-11-10

### Fixed

- Portals and teleporter pads no longer drop a player into burning fire or
  onto a worm.
- Players no longer (re)spawn inside a ticking nuke's red zone: the disc
  is wider than the spawn safety check looked, and the fuse outlasts the
  spawn shield.
- Battle royale: players who join before the zone first moves count as in
  the match, so a match started alone ends with a winner when they're out.

### Added

- German, French, Spanish, Italian and Polish translations of the client.

### Changed

- Portals and teleporter pads never drop a player inside an atomic bomb's
  red zone (a ticking nuke's disc, or one still burning): the trip is
  refused, like a blocked exit.
- Battle royale always has a winner: when the zone closes to nothing the
  storm spares whoever is closest to its centre, and if the last players
  go down together the one with the best score wins.
- The battle royale "Out of this match" notice is a small panel in the
  bottom-right corner instead of a large message in the middle of the screen.

### Removed

- The Russian translation.

## [0.5.0] - 2026-11-10

### Added

- **Worms arena** (new mode `worms`, in the default arenas as
  `Worms:worms:61:6`): giant worms crawl the lanes and hunt the nearest
  player. Touching one eats you and grows the worm; blasts destroy the
  segments they touch, cutting a worm into pieces that crawl on alone or
  killing it (+1 point to whoever's fire ends it). Worms burrow back over
  time, away from players. Tuning lives in `WormTuning`
  (`src/game/worms.rs`). Worms maps use the open, connected layout.
- Worms in snapshots (a `WORMS` part in the `EXTRA` section: every worm,
  in view with all its cells, out of view by its head) and worm news
  events (`ev` kind 12: eaten, killed, cut).
- Worms in the client in both art styles, sliding smoothly between cells
  and turning red-eyed while they hunt, plus mounds where they burrow out,
  on the minimap, and in the kill feed ("eaten by a worm"), in English,
  Ukrainian and Russian.
- Bots keep away from worms and bomb them for points.

## [0.4.0] - 2026-11-10

### Added

- Settings can hide the minimap (also the **N** key) and set its size
  (110–280 px); the FPS panel moves along with it.
- Two new map layouts: **Maze** (pillar gaps walled into a winding maze
  with loops) and **Rings** (concentric walled rings with gates).
- `mapview` binary: prints generated maps as text with their style and
  quality report (`cargo run --release --bin mapview -- --size 41`).

### Changed

- The map generator builds three candidate layouts per seed and keeps the
  one with the best quality score: spawn points spread over the whole arena,
  crates balanced between the quarters, few dead ends. The score is logged
  with each generated map.
- Spawn pockets are spread out (farthest-point sampling) instead of random.
- On mirrored and rotated maps, crates and spawn pockets mirror too, not
  just walls, so no side starts with an advantage.
- Crate cover uses smoother two-octave noise: broad thickets and clearings
  with clumps inside them. Mazes get fewer crates.
- Crates next to teleporter pads are cleared, so pads are never buried.

### Fixed

- The Docker image builds again: it now copies `config/`, which the
  server compiles in for the default ability tuning.

## [0.3.0] - 2026-11-10

### Added

- **Six ability power-ups**, all tuned from `config/abilities.json` (or
  `--abilities <file>` / `ABILITIES_CONFIG`) without code changes: **builder**
  (temporary walls), **gas bombs** (a slowing cloud that fire ignites once),
  **clone** (a decoy replaying your moves from 2 s ago), **sticky bombs**
  (thrown, they stick to enemies; hold C to shake one off), **portal pair**
  and **dash**. Active abilities use the new **R** key (gamepad right
  trigger, a touch button), with charges and cooldowns shown in the HUD; X
  cancels a half-placed portal pair.
- Ability events (`ev` kind 11) and an `EXTRA` snapshot section with gas
  clouds, portals, clones, decoy bombs and who carries which sticky bomb;
  twelve new `me` fields; the welcome carries the ability tuning.
- Bots use dashes to escape, walls and clones near enemies, and portals.
- `docs/ABILITIES.md`: the design, the protocol, how to add another ability,
  benchmark results and known limitations.

### Changed

- `serde_json` is now a runtime dependency (the ability config).
- Bombs going off in the same tick, and players hit by fire in the same
  tick, are handled in id order, so identical input gives an identical game.

## [0.2.0] - 2026-11-10

### Added

- **Gadgets** fired with the new **Q** key (gamepad B, a touch button): land
  mines (hidden from enemies, go off when one comes next to them), rockets
  (fly straight and explode on impact), swap (trade places with the nearest
  enemy), a bomber **drone** that hunts the nearest enemy and drops bombs,
  and a **drone swarm** (five drones, one bomb each).
- **Freeze** power-up (blasts leave ice for 8 s) and **stomp** power-up
  (landing a jump stuns adjacent enemies for 1 s).
- **Sudden death**: the last minute of each round shrinks the arena ring by
  ring towards a random centre; the next ring is shown in red and crushes
  whoever stays in it. The arena reopens for the next round.
- **Map events** every one to two minutes: meteor showers, blizzards (slower
  movement, fogged minimap), lava surges and earthquakes in volcanic regions
  (fissures of fire, bombs jolted by tremors, crates breaking and pillars
  crumbling into rubble until the next round) and reversed conveyors.
- **Capture the flag** in the Teams arena: bases, flags, carriers (who can't
  jump or bomb), drops, returns, captures worth 5 points, and respawning
  near your base.
- **Death replay**: the moments before your death play again in slow motion
  until you respawn.
- **Humans arena** (`Humans:ffa:51:0`): a free-for-all with no bots, for
  real players only.
- **Alerts**: announcements are queued cards with an icon, a hint line, a
  colour by severity and a timer bar (urgent ones go first, repeats merge);
  power-ups and flag news are toasts lower down; ongoing dangers (in the
  storm, in a nuke's zone, at the sudden-death edge, stunned, carrying the
  flag) are pinned status pills with a live bar. Screen readers hear them.
- **Battle royale arena** (`Royale:royale:81:15`, new `royale` mode): last
  player standing in a safe zone that shrinks in five phases, with the next
  circle shown before each move; a storm outside it that kills after 5 s
  (down to 1 s in the last phase); no respawns mid-match; spectating the
  nearest survivor; a new match a few seconds after each win. Its maps are
  open and fully connected (crate-free roads, no enclosed pockets), and bots
  follow the zone.
- **Bots** hop over pillars when it's quicker or safer, and use gadgets.

- **Jumping.** Hold Space to hop over the stone pillar in front of you into
  the free cell behind it (0.4 s hop, 0.5 s cooldown). Airborne players are
  above the fire but can't steer; a bomb pressed mid-air drops on landing.
  Crates and the map border can't be jumped. Gamepad: Y. Touch: a new jump
  button. Predicted on the client like walking, so it responds at once.
- **Atomic bomb** power-up (1% of crate drops, also from secret boxes): the
  next bomb is a nuke with a 3.5 s fuse and a round blast of radius 6 that
  spreads outward as a shockwave. Pillars give no cover; crates (armored
  ones too) and items are vaporized; bombs in reach go off as the wave
  arrives. Shown with a flash, shockwave ring, burning ground, mushroom
  cloud, screen shake and a deep boom. Bots understand and use it.
- **Danger zone** for ticking atomic bombs: every cell that will burn is
  tinted red with a bold safe-line, a countdown floats above the bomb, the
  minimap marks the zone, and players inside it get an escape arrow and a
  warning banner. Nukes just outside your view are sent too.
- **Random maps**: each server start picks a fresh map layout (logged, and
  repeatable with `--map-seed`).
- **Self-contained executable**: release builds embed the browser client
  (`static/`), with content types and `ETag` revalidation. Debug builds still
  serve `static/` from disk, and `--static-dir` overrides either.
- **Release workflow** (`.github/workflows/release.yml`): pushing a `v*` tag
  builds Linux (x86_64, arm64), macOS (Apple Silicon, Intel) and Windows
  executables and attaches them, with `SHA256SUMS`, to a GitHub release.
- Apache-2.0 `LICENSE` and `NOTICE`; authorship and license in `Cargo.toml`.

### Changed

- **Controls**: bombs moved from Space to **F** (Enter still works), Space
  is now jump, and the FPS toggle moved from F to **P**. Gamepad X is the
  action button (Y is jump).
- **Snappier, smoother client**:
  - your own movement shows on the next frame after a key press (was 2–4
    frames), and changed input is sent at once instead of on the next 50 ms
    step;
  - server corrections glide out instead of snapping;
  - the interpolation delay for other players adapts to network jitter
    (about 60 ms on a good connection, was a fixed 100 ms);
  - particles are drawn in batches (3–6× faster), and players' colours,
    sprites and name tags are cached;
  - fewer canvas state changes, the vignette is a CSS overlay, the minimap
    only rebuilds when tiles change and is sharp on high-DPI screens, and
    tile repaints are spread over frames after big blasts;
  - about 35% less script time per frame overall.
- Secret box outcome codes moved to 100 and up to make room for new items,
  and a jump can now start from anywhere in a cell (it still takes off
  from the centre).
- **Wire protocol**: replaced the MessagePack messages with a compact binary
  protocol with delta-compressed snapshots (the welcome message keeps a
  MessagePack body). The player look in snapshots is now a varint, and the
  player state has `nukes`, `jump`, `jump_cd`, `gadget`, `gadget_n`, `freeze`,
  `stomp`, `stun`, `blizzard` and `carrying` fields. New: a `gadget` client
  message, a generic game `event` message (sudden death, map events, flags,
  swaps) and a drones section in snapshots. Clients and servers
  of different versions can't talk to each other; the client ships with the
  server.
- The Docker image now holds just the executable.

## [0.1.0] - 2026-11-09

Initial version.

### Added

- Real-time multiplayer bomb arena server (Rust, axum, tokio) simulating each
  arena at 20 ticks per second, with a browser client in plain ES modules.
- Arenas: a large free-for-all, a red-vs-blue team arena and a small arena,
  each with AI bots, configurable from the command line.
- Power-ups (extra bomb, range, speed, kick, shield, pierce, full fire,
  remote, line bomb, punch, ghost) and the secret box with jackpots, curses
  and bomb rain.
- Biomes with their own hazards: ice, conveyor belts, armored crates and
  linked teleporters.
- Client-side prediction, snapshot interpolation, areas of interest and zoom.
- Profiles with levels, cosmetics (hats and trails), an all-time
  leaderboard, kill feed, streaks, bounties, king-of-the-hill zones and
  rounds with MVPs.
- Pixel-art and classic art styles, music and sound effects, a tutorial,
  colour-blind and high-contrast options, and English, Russian and Ukrainian.
- Server dashboard, `/api/stats` and Prometheus `/metrics`, plus Docker,
  docker-compose and Caddy deployment files.

[0.6.1]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.6.1
[0.6.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.6.0
[0.5.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.5.0
[0.4.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.4.0
[0.3.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.3.0
[0.2.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.2.0
[0.1.0]: https://github.com/RustedBytes/blast-arena/tree/3873267
