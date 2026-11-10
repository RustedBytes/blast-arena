# Changelog

All notable changes to Blast Arena are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-10

### Added

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
- **Wire protocol**: replaced the MessagePack messages with a compact binary
  protocol with delta-compressed snapshots (the welcome message keeps a
  MessagePack body). The player look in snapshots is now a varint, and the
  player state has `nukes`, `jump` and `jump_cd` fields. Clients and servers
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

[0.2.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.2.0
[0.1.0]: https://github.com/RustedBytes/blast-arena/tree/3873267
