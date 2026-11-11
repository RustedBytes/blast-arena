# Ability power-ups: Builder, Gas Bomb, Clone, Sticky Bomb, Portal Pair, Dash

This document describes how the six power-ups from the specification are
built into the existing Blast Arena engine: the architecture, the
configuration, the network protocol, the changes to the bomb and collision
systems, the tests, profiling results, known limitations, and how to add
another power-up.

## 1. How it fits the engine

The server runs the authoritative simulation, one `World` per arena, at a
fixed **20 Hz** step (`TICK_RATE`). The specification recommends 30 Hz, but
the whole engine, client prediction, delta snapshots and the balance of the
existing power-ups are built around 20 Hz. Following the rule "don't replace
existing abstractions without need", the rate is unchanged. Every duration in
the configuration is given in milliseconds and converted to ticks with one
rule (see section 3), so a different rate needs no configuration changes.

| In the specification | In the code |
|---|---|
| Player | `game::player::Player` + new ability fields (slot, charges, recharge, dash, gas, portal lock, movement history) |
| Bomb | `game::bomb::Bomb` + `gas`, `sticky`, `attached`, `portal_ready_at` |
| TemporaryObstacle | `game::builder::Wall` + the map tile `Tile::Built` (10) |
| AreaEffect | `game::gas::GasCloud` (cells are fixed when the gas is released) |
| Portal | `game::portal::Portal` (`partner == 0`: waiting for its pair) |
| Clone | `game::clone::Clone`, `Decoy` (fake bomb), `History` (movement ring buffer) |
| Ability contract | the shared `game::abilities` module (its docs map `canActivate/activate/update/...`) |
| Configuration | `config/abilities.json` → `game::ability_config::Tuning` |

The ability contract isn't a trait object per player. That would cost an
allocation and a virtual call per player per tick in a hot loop that
currently allocates nothing. It's a set of fixed entry points on `World`
instead:

| Contract method | Implementation |
|---|---|
| `canActivate` | `World::check_ability` (shared checks) + the module's placement check (`wall_blocked`, `portal_target`, clone history) |
| `activate` | `World::use_ability` → `place_wall` / `spawn_clone` / `place_portal` / `start_dash`; bomb modifiers in `place_bomb` |
| `update` | `update_walls`, `update_gas`, `update_clones`, `update_sticky`, `update_portals`, `dash_step`, `recharge_abilities` |
| `onCollision` | `dash_step` (swept movement), `update_sticky` / `sticky_hit` (contact), `portal_entry` / `bomb_portal` |
| `onDamage` | `damage_wall`, `ignite` (gas), clone destruction in `update_clones` |
| `deactivate` | `abilities_on_death`, expiry in the `update_*` functions |
| `serialize` | the snapshot's `EXTRA` section and `me` fields (see section 4) |
| `reset` | `reset_abilities_for_round` (end of round, start of a battle royale match) |

### 1.1. Inventory

* **Active abilities** (Builder, Clone, Portal Pair, Dash) share one slot,
  like gadgets: picking up a different one replaces it, the same one refills
  its charges. Charges are spent only on a successful activation; a spent
  charge comes back after the ability's cooldown, which starts on a
  successful activation. A failed attempt costs nothing and sends the player
  `AbilityRejected` with the reason.
* **Bomb modifiers** (Gas, Sticky) have their own charge counters, used up by
  the next bombs. They are mutually exclusive: picking one up drops the
  other. The atomic bomb takes precedence over both.
* On death the ability and modifiers are lost and may drop as items, like
  other power-ups.

### 1.2. Order within a tick

`tick.rs::step`:

1. `read_inputs`: commands from the lock-free input slots (press counters,
   so a repeated delivery never repeats an action).
2. `update_bots`.
3. `update_players` in ascending id order: jump → **dash** (instead of
   walking) → walking → map teleporters → **portals** → item pickup →
   actions (action, gadget, cancel, **ability**, bomb) → **history** record
   for clones.
4. `update_drones`, `update_mines`, `update_sliding_bombs` (+ **portals for
   bombs**, a sliding sticky bomb **sticking** to a player).
5. `update_sticky`: attached bombs follow their carrier, contact with a bomb
   on the ground, shaking off.
6. `update_fuses`: detonations in id order.
7. `update_gas`: expiry, **ignition** by this tick's fire, slowdown.
8. `apply_flame_damage` (in id order).
9. `update_clones`, `update_walls`, `update_portals`, `recharge_abilities`.
10. Snapshots and events (`send_updates`).

An object created in tick N doesn't activate again in that tick: gas
released in tick N can ignite from tick N+1 on, and a new portal locks out
(`portal_lock`) whoever is standing on it.

## 2. Mechanics in brief

**Builder** (`builder.rs`). The wall goes in the cell in front of the player
(`placementRange`). Allowed only on floor or ice, with no bomb, item, portal
or flag base, and no player overlapping the cell even slightly. A wall is the
`Built` tile: solid for movement (ghosts included), blasts, gas, client
prediction and the AI. A normal blast takes 1 HP and stops at the wall; a
piercing blast continues; an atomic blast destroys it. The original tile is
saved underneath and restored when the wall is destroyed or expires. Walls
outlive their owner.

**Gas Bomb** (`gas.rs`). A bomb with the usual fuse, but instead of fire it
releases a cross of gas with radius `radius` (+ up to `rangeBonus` from range
power-ups), stopping in front of solid cells. Everyone inside gets
`gassed_until = tick + slowAfterExit` every tick. The speed multiplier
doesn't stack: the strongest slowdown applies (gas, curse, blizzard). Fire
in any cell of the cloud (from the tick after release) ignites it once: every
player in the cloud gets one damage event (a shield protects), and the cloud
is gone. Ignition creates no fire on the cells, so it doesn't set off bombs
and can't start a chain. At most `maxActiveClouds` clouds per player: the
oldest makes room.

**Clone** (`clone.rs`). Every player writes a movement frame each tick into a
64-tick (3.2 s) ring buffer. A clone appears where its owner was
`playbackDelay` ago and replays the recording. The server doesn't let it
into a cell that has become solid, or skip cells (a teleport in the
recording): the clone waits until the recording comes back next to it. A
bomb placement in the recording creates a decoy bomb (only a picture, in a
separate `decoys` list). A clone picks nothing up, doesn't use portals,
can't be stuck to, and ignores gas; a blast destroys it, and so does its
owner's death.

**Sticky Bomb** (`sticky.rs`). Thrown `throwRange` cells ahead: it sticks to
the first eligible player in its path, otherwise lands on the last free cell
(or at the thrower's feet). A bomb on the ground sticks to whoever walks into
its cell or pushes against it. An attached bomb leaves the bomb grid (it
doesn't block and can't be kicked); its position is the carrier's cell every
tick, so it goes through portals with them. The owner never changes. Holding
the detach key for `detachDuration` drops the bomb on the nearest free cell
(the fuse keeps running); if the fuse runs out first, it explodes. If the
carrier dies or leaves, the bomb stays on their last cell. A shield blocks
the damage, not the sticking.

**Portal Pair** (`portal.rs`). The first press places an inactive portal on
the farthest free cell up to `placementRange` ahead (the line stops at
anything solid; otherwise the player's own cell), the second press places its
partner; a charge and the cooldown are spent only on a full pair. A waiting
portal disappears after `placementTimeout` or is cancelled (X). A trip
happens when a player is at the centre of an active portal's cell (anywhere
in the cell while dashing) and the exit is free (not solid, no bomb, no other
player): they move to the exit's centre, get a `portal_lock` on the exit cell
and the `teleportCooldown`. The next trip needs both leaving that cell
**and** the cooldown ending. A blocked exit cancels the trip, with no
cooldown and no search for an alternative. Sliding bombs (kicked, on a
conveyor) go through the same way, keeping owner, fuse and direction. Fire
and gas don't pass through portals. A pair disappears on expiry, on its
owner's death, and if its cell turns solid.

**Dash** (`dash.rs`). The direction is the one held (or faced) and is fixed
at the start. Each tick's distance is split into sub-steps under 0.5 cells
(swept): movement stops in front of walls, bombs and the map edge, and each
new cell is checked for fire (damage by the normal rules), gas, items and
portals (one trip per dash). No invulnerability (the `invulnerable` option
turns it on). A sticky bomb stays on the player.

## 3. Configuration

`config/abilities.json` is embedded in the binary; `--abilities <file>` (or
`ABILITIES_CONFIG`) replaces it. Any field may be left out to use its
default. Unknown fields, a wrong version or out-of-range values stop the
server with a message.

* **Rounding rule:** `ticks = round_half_up(ms × 20 / 1000)`; durations that
  must be positive are at least 1 tick.
* **Validation:** charges 1..9; gas radius 1..8 and `radius + rangeBonus ≤ 8`;
  `movementMultiplier` in (0, 1]; dash distance in (0, 8]; clone delay
  shorter than the history buffer (3.2 s); `teleportCooldownMs > 0`
  (otherwise an A→B→A loop would be possible); all durations positive;
  object limits bounded.
* **Feature flags:** `enabled: false` switches a power-up off: it no longer
  drops from crates or secret boxes, and one already held won't activate
  (`AbilityRejected` with reason "disabled"). The list of disabled ones is
  sent to the client.

## 4. Network protocol

### 4.1. Client commands

| Specification command | In the protocol |
|---|---|
| `UseAbility`, `PlaceBuilderWall`, `SpawnClone`, `PlacePortal`, `ActivateDash` | `cop::ABILITY` (9), a single byte; the server picks the ability from the player's inventory |
| `PlaceGasBomb`, `PlaceStickyBomb` | the existing `cop::BOMB`: the next bomb becomes gas/sticky by modifier |
| `DetachStickyBomb` | bit 7 of the direction byte in `cop::IN` (a held key, like jump) |
| cancelling a portal pair | `cop::CANCEL` (10) |

Commands carry no `playerId` at all: the player is the owner of the
WebSocket session, so it can't be forged. Presses are counted by counters in
the lock-free slot, so several presses in one tick give one action, and
reading the same counter again does nothing. The server checks the
character's state, that the power-up is held, charges, cooldown, position and
object limits.

### 4.2. Server events

All are `op::EVENT` with kind `ev::ABILITY` (11); values are
`[sub-kind, server tick, ...]` (`game::abilities::ab`):

| Specification event | Sub-kind | Values after the tick | To |
|---|---|---|---|
| AbilityActivated | 1 | player, item code | nearby (owner and team for a clone) |
| AbilityRejected | 2 | item code, reason | the player |
| AbilityCooldownStarted | 3 | item code, ticks | the player |
| WallCreated | 4 | id, owner, x, y, ticks | nearby |
| WallDestroyed | 5 | id, x, y, 1 = destroyed / 0 = expired | nearby |
| GasCloudCreated | 6 | id, owner, x, y, ticks | nearby |
| GasCloudExpired | 7 | id, x, y | nearby |
| GasIgnited | 8 | id, x, y | nearby |
| CloneSpawned | 9 | id, owner, x, y | owner and team |
| CloneDestroyed | 10 | id, x, y, 1 = blast | nearby |
| StickyBombAttached | 11 | bomb, target, owner, x, y | nearby |
| StickyBombDetached | 12 | bomb, target, x, y | nearby |
| PortalCreated | 13 | id, owner, x, y | nearby |
| PortalLinked | 14 | first id, second id, owner, x, y | nearby |
| PortalDestroyed | 15 | id, x, y | nearby |
| EntityTeleported | 16 | 0 player / 1 bomb, id, from x, y, to x, y | nearby |
| DashStarted | 17 | player, direction, x, y | nearby |
| DashEnded | 18 | player, x, y | nearby |

"Nearby" means players whose largest possible view contains the cell.

### 4.3. Snapshots

* A new `EXTRA` section (bit 128 of the section mask): sub-lists `GAS`,
  `PORTALS`, `CLONES`, `DECOYS`, `STUCK` within the area of interest, sent
  whole every time (not as deltas): they are small, and this way the client
  doesn't depend on events that might be missed.
* Bombs gained the flags `sticky` (64) and `gas` (128); an attached bomb is
  in the bomb list at its carrier's cell, and `STUCK` says who carries it.
* Player flags grew to 10 bits: `dashing` (256), `gassed` (512).
* `me` fields (47 instead of 35): `ability`, `ability_n`, `ability_max`,
  `ability_cd`, `gas_bombs`, `sticky_bombs`, `stuck` (fuse of the bomb on me
  + 1), `detach` (shake-off progress), `gassed`, `dash`, `dash_dir`,
  `portal_wait`.
* The welcome carries `abilities` (version `v`, cooldowns, durations, dash
  step, gas multiplier, disabled power-ups).

Critical events (sticking, detonation, teleporting, walls) are decided by the
server alone; the client shows them from snapshots. Client prediction knows
about walls and the gas slowdown, and continues a dash as soon as a snapshot
shows it; a portal trip is corrected by reconciliation with the snapshot. A
reconnecting client gets a full snapshot, so ability state is restored from
it (the abilities themselves, like other temporary power-ups, aren't kept by
the 30-second parking on disconnect).

## 5. Changes to the existing bomb and collision systems

* `Map::is_solid` includes `Tile::Built`; player movement and client
  prediction treat `Built` as solid for ghosts too; `trace_blast` handles
  `Built` like a crate (it stops a non-piercing blast); `explode` and the
  atomic blast damage/destroy the wall without dropping items.
* `explode`, `remove_bomb` and the clean-up at the start of a match clear a
  bomb grid cell only if it holds that very bomb (an attached sticky bomb
  isn't on the grid).
* `kick_bomb` and `update_sliding_bombs` ignore attached bombs; a sliding
  sticky bomb that runs into a player sticks to them; a sliding bomb on a
  portal goes through it.
* `update_fuses` and `apply_flame_damage` handle bombs and victims in id
  order (the order used to depend on `HashMap`), so identical commands give
  an identical result.
* The fire damage check moved into `World::flame_threat`, used by both normal
  damage and the dash's swept check.
* `Item::crate_drop` takes a filter for enabled power-ups; drop weights are
  now out of 224 (each new power-up gets 4/224).
* Bots dash to escape, use walls and clones near enemies, and place portals;
  bomb modifiers work for them automatically.

## 6. Tests

`cargo test` runs 171 tests, 64 of them new (`src/game/ability_tests.rs`,
`src/game/ability_config.rs`, updated protocol tests). Test names start with
the specification's scenario id:

| Group | Scenarios |
|---|---|
| Builder | B01–B08 + ghosts and players can't pass a wall |
| Gas Bomb | G01–G08 + cloud limit per player |
| Clone | C01–C08 + decoy bombs, new walls in the recording's path, the clone hidden from enemies |
| Sticky Bomb | S01–S08, S09 (dash), picking a bomb up from the ground |
| Portal Pair | P01–P10 + placement rules, cancel, timeout |
| Dash | D01–D09 (D09 together with S04), fixed direction, no shield |
| Network/system | N01, N04–N10; configuration: specification values, rounding rule, partial files, invalid values; disabled power-ups |

N02 (150 ms latency) and N03 (packet loss) are covered by the existing
architecture: delta snapshots against an acknowledged base, a full snapshot
when the base is unknown, and prediction reconciliation. There are no
separate network tests that emulate latency (see section 8).

## 7. Profiling

`cargo run --release --bin simbench -- --ticks 2000` (200 bots, 150 clients
with real snapshot encoding, a 101×101 map), before and after, three runs
each:

| | average tick | p99 tick | allocations per tick | snapshot per client per tick |
|---|---|---|---|---|
| before | 1.36–1.39 ms | 2.01–2.22 ms | 0.09–0.14 (29–56 B) | 112 B |
| after | 1.37–1.44 ms | 2.04–2.99 ms | 0.10 (26 B) | 117 B |

The tick budget is 50 ms. In 2000 ticks the bots made 76 dashes, 36 clones,
19 portal pairs (56 teleports), 6 sticky bomb hits and 10 gas ignitions
(1130 ability events). The new code adds no allocations in steady state
(object lists and working buffers are reused), and the extra 5 B per
snapshot is the `EXTRA` section. The three runs after the change gave
**bit-identical** results (before, results differed run to run because of
`HashMap` iteration order), which test N08 also checks.

## 8. Known limitations and open questions

* **20 Hz instead of 30 Hz** (see section 1). A dash of 0.2 s is 4 ticks of
  0.625 cells, with sub-steps.
* **No separate id "generation" field**: every object (bombs, walls, clouds,
  clones, portals) takes its id from one 32-bit counter, so ids don't repeat
  during an arena's life (about 2 billion objects); stale events about a
  reused id can't happen in practice.
* **The sticky bomb throw is instant** (the `FLYING` state resolves in the
  throw's tick): simpler to synchronize, but there's no flight animation.
* **Client prediction doesn't predict a dash starting or portal trips**: the
  server starts them; the client picks up a dash from the snapshot (about one
  round trip later), and a teleport is fixed by reconciliation.
* **Visibility in gas** is reduced only by a local frame on the client; the
  server hides nothing.
* **A clone** can be recognized by a modified client (it's a separate
  sub-list in the snapshot); to an honest client it's indistinguishable
  (the owner's name, colours, hat).
* **Gas ignition doesn't set off bombs** inside the cloud (otherwise the blast
  would reach beyond the cloud, against the specification). If detonation is
  wanted, that's a game-design decision.
* **The load targets** of section 14 of the specification aren't hard limits:
  walls, clouds, clones and portals are capped per player by the
  configuration.
* There are no dedicated pixel-art icons for the new power-ups: the pixel art
  style uses the SVG icons (`static/assets/pu_*.svg`).

## 9. How to add a new power-up

1. **Item.** Add a variant to `Item` (`items.rs`) with the next code, update
   `ALL_ITEMS`, `from_u8`, the weights in `Item::random`, the
   `Mystery::open` pool, and `is_ability` (if it's an ability).
2. **Configuration.** A struct with `#[serde(default)]` in
   `ability_config.rs`, a field in `Abilities`, validation and tick
   conversion in `Tuning::from_abilities`, values in
   `config/abilities.json`, a branch in `Tuning::item_enabled`.
3. **Inventory.** A branch in `grant_ability` (the active ability slot or a
   separate modifier counter), its cooldown in `ability_cooldown`.
4. **Mechanics.** A new module `src/game/<name>.rs` with `impl World`:
   activation (`Result<bool, i64>`: `Ok(true)` spends a charge,
   `Err(reject::…)` refuses at no cost), `update_<name>` and `clear_<name>`.
   Add a branch in `use_ability`, a call to `update_<name>` at the right place
   in `step` (see 1.2), and clean-up in `abilities_on_death` and
   `reset_abilities_for_round`.
5. **Protocol.** A new sub-kind in `abilities::ab` (and `AB` in
   `client/protocol/constants.ts`); if its objects must be shown, an `EXTRA`
   sub-list in `protocol::snap`, `World::write_extra`, the test decoder in
   `protocol::testing` and the decoder in `client/protocol/snapshot.ts`; new
   `me` fields go at the end of `ME_FIELDS` on both sides (the client's is in
   `client/protocol/constants.ts`).
6. **Client.** An icon `static/assets/pu_<name>.svg` (+ `SPRITES` and
   `ITEM_SPRITES` in `client/assets.ts`, a halo colour in `HALO` in `client/render/constants.ts`),
   texts in `client/i18n/*.ts`, drawing in a layer under `client/render/`, sounds and notices
   in `abilityEvent` (`client/app/events.ts`).
7. **Tests** in `ability_tests.rs`: at least a successful activation, a
   refusal that costs nothing, expiry, the owner's death, the end of a round,
   and serialization into the snapshot.
