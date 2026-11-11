# Changelog

All notable changes to Blast Arena are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A Heart power-up (item 27) in the dungeon arena: picking it up brings
  back every heart lost to monster bites. It comes from about 8% of
  crate drops and a third of slain monsters' drops there, and nowhere
  else (never from secret boxes). A heart coming back, over time or from
  the power-up, now sparkles on your player, and healing over time shows
  a "+1 heart" notice.

### Changed

- Dungeon arena: players have three hearts against monsters. A bite takes
  one (the last one kills) and makes you blink for 2 s: no monster can
  bite you and they all lose interest, and the one that bit you staggers
  for a second, so you can get away from a bat or a slime. Hearts come
  back one every 8 s without a bite; fire still kills in one go. The HUD
  shows your hearts, and other players see a bitten player blink. Bats
  now chase a little slower than a player walks. The player's own state
  gains `hp` and `hp_max`, player flags a "just bitten" bit (1024) and a
  "wounded" bit (2048), and monster news a "wounded" event (4, with the
  hearts left). The monster that bit is knocked back a cell. A wounded
  player leaves a trail of blood drops while walking (more of them while
  blinking), which dry darker and fade after a few seconds.

### Added

- A "Bomb / rocket key" setting: F drops bombs (and fires rockets) and
  Space jumps, as before, or the two are swapped so Space drops bombs and
  F jumps. Enter always drops a bomb. The key caps in the lobby help, the
  controls list and the tutorial follow the setting.

### Changed

- Less CPU for big bot crowds (back-pressure on the arena task):
  - An arena with no humans in it steps once a second instead of 20
    times: nobody sees it, and the first human to join starts the round
    over anyway. Joins are still handled every tick.
  - Level of detail for bots: in an arena with 100 or more bots, a bot no
    human can see (beyond the widest view plus 8 cells) plans every 8–14
    ticks instead of every 2–4. It still reacts at once to danger and to a
    blocked path. With one human in the Horde a tick takes 2.3 ms instead
    of 4.2 ms in `simbench --bots 1000 --map-size 321 --clients 1`.
  - When an arena's ticks average over 8 ms for a second, far-away bots
    slow down a further step (up to 4×), and speed back up below 4 ms.

### Fixed

- The dashboard and `/metrics` showed a huge "round left" for the Royale
  arena (its matches have no clock); it is 0 now.

## [0.9.0] - 2026-11-11

### Added

- A Dungeon arena (`dungeon` mode, `Dungeon:dungeon:61:6` in the default
  list): a free-for-all on a new dungeon map of crate-filled rooms joined
  by narrow, winding corridors, in a new crypt region (flagstone floors,
  dark brick walls with torches; `mapview --dungeon` previews them).
  Monsters roam it and hunt players: slow slimes that never see a bomb
  coming, two-blast skeletons that dodge fire, and erratic bats that fly
  over crates and bombs. Touching one kills you; blowing one up scores and
  may drop a power-up. Monsters are sent in a new MONSTERS part of the
  snapshot EXTRA section and as monster news events (ev kind 14); the
  client draws them in pixel and classic styles, on the minimap and in the
  kill feed, and bots treat them as danger and targets. Tuning lives in
  `MonsterTuning` (src/game/monsters.rs).

- A Horde arena (`Horde:ffa:321:1000` in the default list): a
  free-for-all with a thousand bots on a 321×321 map, about 100 cells
  each. An arena's player limit (`--max-players`) is now raised to fit
  its bots, and a human joining a full arena still takes a bot's place.
  A tick of it takes about 4 ms in `simbench --bots 1000 --map-size 321`
  and about 8 ms in the running server, of the 50 ms each tick has.

- A Rockets arena (`rockets` mode, `Rockets:rockets:51:8` in the default
  list): a free-for-all where the bomb key fires a rocket in the
  direction you're walking or facing instead of dropping a bomb. Rockets
  reuse the rocket gadget's flight and impact, carry your range, pierce
  and freeze, and count towards your bomb limit. Bots aim down open lanes
  at enemies and nearby crates, and dodge rockets flying their way: the
  danger map now follows each rocket's lane, in every arena.

- A `webtransport` cargo feature, on by default. `--no-default-features`
  builds without WebTransport (118 crates to compile instead of 200) for
  faster local builds and tests; such a server serves everyone over the
  WebSocket.

- Caddy sends security headers (HSTS, a Content-Security-Policy that only
  allows the site's own scripts, `nosniff`, referrer and permissions
  policies), holds requests for up to 10 s while the game restarts and
  health-checks it, keeps WebSockets open for 5 minutes across a config
  reload, compresses only responses worth it, and writes a JSON access
  log without the lobby's API polling.

- WebTransport (HTTP/3 over QUIC) with the WebSocket as the fallback.
  Snapshots go as unreliable datagrams, so a lost packet no longer holds
  back newer ones (TCP's head-of-line blocking); reliable messages share
  one length-prefixed stream. The client asks `/api/transport` where to
  connect and falls back to the WebSocket when WebTransport is missing,
  off or not up within 3 seconds, remembering that for the tab. By
  default the server uses a self-signed certificate (13 days, renewed
  every 6) that browsers accept by its hash; `--wt-cert`/`--wt-key` take
  a real one. New flags: `--wt-port` (defaults to `--port`, 0 turns it
  off), `--wt-public-port`, `--wt-cert`, `--wt-key`. Docker Compose
  publishes UDP 443 to the game and keeps Caddy off HTTP/3. Joins are
  logged with their transport, and the network readout shows `WT` or `WS`.

### Changed

- Sudden death never closes a ring faster than one every 7 ticks (2.9
  tiles a second, slower than walking), so players always have time to
  get inside. On maps wider than about 200 cells that means the arena no
  longer closes all the way before the round ends; smaller maps are
  unchanged.

- The first human to join an arena that only bots are playing in starts
  the round from the beginning: the full timer, everyone's score back to
  zero, sudden death and flags reset, new hills. In battle royale they
  start a new match with everyone in it instead of watching the bots'
  one. Nobody is named MVP or rewarded for the bots' round, and a player
  coming back to their parked state carries on as before.

- The server runs a tokio worker thread per CPU core again
  (`TOKIO_WORKER_THREADS` sets another count), so arenas tick in
  parallel and a big arena such as Horde doesn't hold up the others.
  A single-threaded runtime used less memory but ran every arena, socket
  and HTTP request on one thread. The Docker image tunes mimalloc to
  return freed memory to the OS at once (`MIMALLOC_PURGE_DELAY=0`) and to
  commit arena memory only as it's used (`MIMALLOC_ARENA_EAGER_COMMIT=0`).

- About 230 KB less memory per connected player. Each WebSocket's read
  buffer is 4 KiB (the largest client message) instead of tungstenite's
  128 KiB, which it fills in full. Each client's snapshot history starts
  sized for a typical view and grows only if needed, instead of reserving
  room for 96 players and 64 bombs in each of its 32 slots. With 100
  bots connected, the server used 17 MB instead of 35 MB.

- Deno replaces Node.js and npm for the client build. `deno.json` holds
  the tasks (`deno task build`, `build:dev`, `watch`, `check`) and the
  build tools as `npm:` dependencies, pinned in `deno.lock`; the browser
  list moved from `package.json` to `.browserslistrc`. The tools are the
  same (esbuild, Sass, Lightning CSS, `tsc`, ESLint with typescript-eslint
  and eslint-plugin-compat) and the output is unchanged. Docker builds the
  client with `denoland/deno:2.9.8` and the release workflow with
  `setup-deno`, both with `deno install --frozen`. Sass is 1.108.1, as
  Deno skips releases younger than a day. Deno doesn't support npm
  `overrides`, so `deno audit` again reports the moderate `minimatch`
  advisory inside ESLint (dev tooling only, never sees untrusted input).

- Faster builds. Docker compiles the dependencies in a cached layer of
  their own, so a code change rebuilds only the server. Fewer crates: log
  filters use `tracing-subscriber`'s `Targets` instead of `EnvFilter` (no
  regex engine; filters are a level plus `target=level` pairs, as before),
  tokio has only the features the server uses (no `parking_lot`), and the
  bots tool uses the same `tokio-tungstenite` as axum instead of a second
  copy. `db.rs` logs through `tracing` like the rest of the server.

- The lobby's all-time list shows each player's XP, the value it is ranked
  by. With only level and kills shown, players on the same level looked
  out of order (12 XP with no kills above 10 XP with one). Ties now go to
  more wins, then more kills, then fewer deaths, and profiles with no XP
  are left off.

- The Docker image runs on Alpine 3.24 instead of Debian slim: every stage
  is Alpine-based, the server is built for musl, and musl builds use
  mimalloc as the global allocator (musl's own scales poorly across the
  runtime's worker threads). Other builds keep the system allocator.

- Build tools upgraded: ESLint 10 (with `@eslint/js` 10), TypeScript 6.0,
  esbuild 0.28, and the latest Sass, Lightning CSS, PostCSS and
  typescript-eslint. TypeScript stays on 6.0, the newest typescript-eslint
  supports (TypeScript 7's native compiler has no API for it yet). A
  `minimatch` override (^11.0.8) fixes a moderate advisory
  (GHSA-g3hv-75wg-m249) in ESLint's dependencies without downgrading
  ESLint; `npm audit` reports 0 vulnerabilities. Install scripts are
  reviewed in `allowScripts` (esbuild's allowed; the optional file-watcher
  build Sass pulls in is denied, as nothing here uses it). Node 26, the
  current LTS, builds the client in Docker and the release workflow, and
  `engines` asks for Node 22.13 or newer.
- Fixed along the way: the client encoder's bytes are typed as plain
  `ArrayBuffer`-backed (what `WebSocket.send` takes), the build script
  imports `Buffer`, and a needless initial assignment went away.

- The stylesheet is SCSS now (`client/styles/`): design tokens and mixins
  (breakpoints, round buttons, fields, edge tints, countdown rings) in
  `_tokens.scss`, and one partial per part of the page with its responsive
  rules beside it. The alert tones, their RGB triplets and the touch-button
  layouts (upright and landscape) are generated from maps instead of being
  written out by hand. The build merges each media query into a single block
  (11 instead of 76), and the output is smaller than before (25.6 KB,
  6.3 KB gzipped). A computed-style comparison of every element in 48 page
  states and screen sizes matches the old stylesheet, except for two layout
  fixes that the old rule order had hidden: the tutorial's Back button uses
  the tutorial's button size, and its card uses its narrow-screen padding
  on phones.

### Fixed

- Profiles weren't saved after the switch to the Alpine image ("attempt
  to write a readonly database"). Alpine gave the `blast` user ID 100,
  but volumes made by the Debian image belong to 999, so SQLite could read
  the database and not write it. The image pins the user to 999:999 again,
  and the server refuses, with the reason, a database file it can only
  read instead of failing on every save.

- `/favicon.ico` returned 404: browsers and crawlers ask for it on their own.
  It's now a 16/32/48 px icon rendered from `favicon.svg`, linked from every
  page and covered by a server test.

- The client is built for about 95% of the world's browsers (browserslist
  `cover 95%, not dead`: Chrome 103+, Firefox 115+, Safari and iOS 15.6+,
  Samsung Internet, UC and QQ Browser). esbuild compiles the JavaScript down
  to their oldest engine (Chrome 78), and the stylesheet moved to
  `client/style.css`, minified by Lightning CSS into `static/style.css` with
  vendor prefixes and fallbacks. Newer APIs those browsers lack
  (`Array.at`, `Object.hasOwn`, `replaceAll`, `replaceChildren`, top-level
  `await`) are no longer used, and `eslint-plugin-compat` checks for them.
- Fixed: colour-blind player shades and alert borders used CSS
  `color-mix()`, which Chrome before 111 and Safari before 16.2 don't
  support (shades turned black, alerts lost their glow).

- A new tutorial: an illustrated slide deck in a modal window, in every
  language. 14 short slides, each with a picture drawn from the game's pixel
  art (little scenes such as the blast cross or a hop over a pillar, and the
  real power-up tokens with their names): moving, bombs, jumping, crates,
  boosts, tricks, gadgets (Q), abilities (R), the secret box and atomic bomb,
  the arena's regions, dangers, the arena modes and scoring. It opens the
  first time you press Play, before joining, from the new **How to play**
  button in the lobby, and from settings. Back/Next, dots, arrow keys and
  swipes turn the pages, Esc closes it, and the game's controls are off
  while it's open. It replaces the old four-step tips box.

- The client ships as one minified file per page: esbuild bundles
  `client/` into `static/js/main.js` (the game, about 210 KB, 80 KB
  gzipped; it was 70 separate modules, 588 KB), `dashboard.js` and
  `tilelab.js`. `npm run build` is the production build, `npm run
  build:dev` and `npm run watch` keep it readable with source maps, and
  `tsc` now only type-checks (`npm run check`).

- README: new screenshots (gameplay, worms, battle royale, the vault and its
  Warden, the lobby) with captions, build prerequisites, a development
  section, the vault and Warden under Gameplay, and a map of the client's
  modules.

- Client type safety: stricter compiler settings (`exactOptionalPropertyTypes`,
  unused code, implicit returns) and typescript-eslint's strict type-aware
  rules, run by `npm run check` and in the release workflow. No `!`
  assertions or `any` left: DOM lookups check element types at run time
  (`client/dom.ts`), and the welcome message, saved settings and `/api`
  responses are validated before use. Snapshot flags have names
  (`PLAYER_FLAG`, `BOMB_FLAG`), classes use `private`/`readonly` fields,
  sprites are looked up by a typed `SpriteName`, and promises are no longer
  left unhandled. Toasts with the same `key` now replace each other.

## [0.8.0] - 2026-11-10

### Added

- Link previews and search: shared links show a card with the logo,
  tagline and a pixel-art map (`static/og-image.jpg`) through Open Graph
  and X/Twitter tags. The page has a proper title and description, a
  canonical link, schema.org `VideoGame` data, a web app manifest with
  PNG icons, and a `<noscript>` description; the Tile Lab and dashboard
  are `noindex`. The server fills in the site's absolute address
  (`src/page.rs`), from the new `--public-url` / `PUBLIC_URL` or the
  request, and serves `/robots.txt` and `/sitemap.xml`.

### Changed

- The browser client is now TypeScript (`client/*.ts`, strict mode), compiled
  by `tsc` into `static/js/` with the same module layout, so the pages load
  it as before. The wire protocol, game state and settings are typed end to
  end. Building needs Node.js: run `npm ci && npm run build` before
  `cargo build` (build.rs stops with a hint if the client isn't built, and
  warns when it's out of date); the Dockerfile and release workflow do it.

## [0.7.0] - 2026-11-10

### Added

- Watch other parts of the map: drag the view box on the minimap (or
  click anywhere on it) and the camera glides there, with the players,
  bombs and fire around that spot. A "Watching the map" pill shows the
  way back; moving, jumping, bombing or using an item, or clicking the
  pill, brings the camera home. New client message `look` (op 11): the
  cell to centre the view on, or none for your own player; snapshots
  always include your own player.
- **The vault and its Warden** (`src/game/guard.rs`, tuning in
  `GuardTuning`): every arena has a walled vault near the middle, with a
  gate in each side and its gilded floor laid with up to 16 strong
  power-ups (bombs, range, speed, full fire, remote, pierce, shields,
  rockets, drones, abilities, the odd nuke or secret box), one more
  restocked every 8 s. It's guarded by the **Warden**, a stone golem with
  8 hit points that fights anyone near the vault (never straying more
  than 6 cells beyond its walls) and crushes whoever it touches:
  - **Slam**: next to you, it winds up (a red square fills in) and
    crushes everyone on the ground within 2 cells; jump to dodge it.
  - **Charge**: lined up with it in a clear lane, it winds up (chevrons
    mark the lane) and charges a cell a tick.
  - **Lob**: farther off, it drops bombs on you.
  - **Stone skin**: at half health, immune for 4 s, once.
  - **Enraged**: on its last 3 hit points it's faster, its skills come
    back sooner and it lobs bombs in threes.
  Only players' blasts hurt it, one hit per blast. Bringing it down is
  worth 5 points and 40 XP; it's back a minute later with the vault
  restocked. Bots fear its reach and bomb it when they can. Nobody
  spawns in or by the vault, and hills, crate regrowth and worms keep out.
  New: snapshot part `GUARD` (the vault, and the Warden with its skill
  telegraphs), event kind 13 (crushed, brought down, back, slam, lob),
  and translations of its notices in every language.

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

[0.9.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.9.0
[0.8.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.8.0
[0.7.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.7.0
[0.6.1]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.6.1
[0.6.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.6.0
[0.5.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.5.0
[0.4.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.4.0
[0.3.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.3.0
[0.2.0]: https://github.com/RustedBytes/blast-arena/releases/tag/v0.2.0
[0.1.0]: https://github.com/RustedBytes/blast-arena/tree/3873267
