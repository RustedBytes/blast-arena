//! Joining, leaving, bots and finding safe spawn points.

use crate::protocol::{self, Welcome};

use super::ai;
use super::link::ClientLink;
use super::map::Tile;
use super::player::{AOI_DEFAULT, AOI_MAX, Player};
use super::profiles::profile_view;
use super::{JoinRequest, Mode, PARK_TICKS, Parked, SPAWN_SHIELD_TICKS, TICK_RATE, World};

impl World {
    /// Adds a human player (making room by removing a bot if the arena is
    /// full) and sends them the welcome. Returns the new player id.
    ///
    /// # Errors
    /// A reason to show the player when the arena is full of humans.
    ///
    /// # Panics
    /// Never: the player looked up after spawning was just inserted.
    pub fn join(&mut self, req: JoinRequest, link: ClientLink) -> Result<u32, &'static str> {
        if self.players.len() >= self.max_players {
            // Humans take priority: a bot steps out to make room.
            let Some(&bot) = self.bot_ids.first() else {
                return Err("server is full, try again later");
            };
            tracing::debug!(bot, "arena full, a bot steps out for a human");
            self.leave(bot);
        }
        let parked = req.token.as_ref().and_then(|t| self.parked.remove(t)).filter(|p| p.expires > self.tick);
        let team = parked.as_ref().map_or_else(|| self.team_for_new(), |p| p.team);
        let (hat, trail) = match &req.profile {
            Some(p) => (p.allowed_hat(req.hat), p.allowed_trail(req.trail)),
            None => (0, 0),
        };
        let near = self.players.get(&req.near).filter(|p| p.alive).map(super::player::Player::cell);
        let id = self.spawn_player(req.name, Some(link), team, hat, trail, near);
        let resumed = parked.is_some();
        let p = self.players.get_mut(&id).unwrap();
        p.token = req.token;
        p.profile = req.profile;
        if let Some(pk) = parked {
            tracing::info!(id, score = pk.score, kills = pk.kills, "player resumed their parked state");
            (p.score, p.kills, p.deaths, p.streak) = (pk.score, pk.kills, pk.deaths, pk.streak);
            (p.max_bombs, p.range, p.speed_lvl) = (pk.max_bombs, pk.range, pk.speed_lvl);
            [p.kick, p.pierce, p.remote, p.line, p.punch] = pk.flags;
        }
        if let Some(prof) = &mut p.profile {
            prof.games += 1;
            p.profile_dirty = true;
        }

        let p = &self.players[&id];
        let mut items = Vec::new();
        for y in 0..self.map.h {
            for x in 0..self.map.w {
                let k = self.items[self.map.idx(x, y)];
                if k != 0 {
                    items.push((x, y, k));
                }
            }
        }
        let welcome = Welcome {
            id,
            w: self.map.w,
            h: self.map.h,
            map: self.map.encode_rle(),
            biomes: self.map.biomes.iter().map(|s| (s.x, s.y, s.biome as u8)).collect(),
            items,
            rate: TICK_RATE,
            aoi: AOI_DEFAULT,
            aoi_max: AOI_MAX,
            roster: self.players.values().map(|o| (o.id, o.name.as_str(), o.team, o.hat, o.trail)).collect(),
            arena: &self.name,
            mode: self.mode.as_str(),
            team: p.team,
            hills: self.hills.clone(),
            round: self.round_secs_left(),
            resumed,
            profile: p.profile.as_ref().map(profile_view),
        };
        if let Some(link) = &p.link {
            let _ = link.events.try_send(welcome.encode());
        }
        // Sudden death and the flags, if any, so the client is up to date.
        let extra = self.event_state_for_join();
        if let Some(link) = &self.players[&id].link {
            for msg in extra {
                let _ = link.events.try_send(msg);
            }
        }
        Ok(id)
    }

    /// The team with fewer players, in team mode.
    pub(super) fn team_for_new(&self) -> u8 {
        if self.mode != Mode::Teams {
            return 0;
        }
        let red = self.players.values().filter(|p| p.team == 1).count();
        let blue = self.players.values().filter(|p| p.team == 2).count();
        if red <= blue { 1 } else { 2 }
    }

    /// Creates a living player at a safe spot and announces it to everyone.
    pub(super) fn spawn_player(&mut self, name: String, link: Option<ClientLink>, team: u8, hat: u8, trail: u8, near: Option<(i32, i32)>) -> u32 {
        self.next_player_id += 1;
        let id = self.next_player_id;
        let mut p = Player::new(id, name, link);
        (p.team, p.hat, p.trail) = (team, hat, trail);
        let (x, y) = match near {
            Some((nx, ny)) => self.find_spawn_near(nx, ny),
            None => self.find_spawn(),
        };
        p.x = x as f32 + 0.5;
        p.y = y as f32 + 0.5;
        p.alive = true;
        p.invulnerable_until = self.tick + SPAWN_SHIELD_TICKS;
        self.broadcasts.push(protocol::encode_pj(self.event_arenas.current(), id, &p.name, team, hat, trail));
        self.players.insert(id, p);
        self.rebuild_buckets();
        id
    }

    pub fn add_bot(&mut self) -> u32 {
        let name = ai::bot_name(self.bots_created);
        let hat = (self.bots_created % 7) as u8;
        self.bots_created += 1;
        let team = self.team_for_new();
        let id = self.spawn_player(name, None, team, hat, 0, None);
        let brain = ai::BotBrain::new(&mut self.rng);
        self.bots.insert(id, brain);
        self.bot_ids.push(id); // ids only grow, so this stays sorted
        id
    }

    /// Tops the bot population back up to the target while there's room.
    pub(super) fn maintain_bots(&mut self) {
        let before = self.bots.len();
        while self.bots.len() < self.target_bots && self.players.len() < self.max_players {
            self.add_bot();
        }
        if self.bots.len() > before {
            tracing::debug!(added = self.bots.len() - before, bots = self.bots.len(), "bots topped up");
        }
    }

    pub fn leave(&mut self, id: u32) {
        if let Some(cell) = self.players.get(&id).map(Player::cell) {
            self.carrier_lost(id, cell);
        }
        self.histories.remove(&id);
        if self.bots.remove(&id).is_some() {
            self.bot_ids.retain(|&b| b != id);
        }
        let Some(p) = self.players.remove(&id) else { return };
        self.broadcasts.push(protocol::encode_pl(self.event_arenas.current(), id));
        if let (Some(db), Some(profile)) = (&self.db, &p.profile) {
            db.save(profile.clone());
        }
        if let Some(token) = p.token {
            self.parked.insert(
                token,
                Parked {
                    expires: self.tick + PARK_TICKS,
                    team: p.team,
                    score: p.score,
                    kills: p.kills,
                    deaths: p.deaths,
                    streak: p.streak,
                    max_bombs: p.max_bombs,
                    range: p.range,
                    speed_lvl: p.speed_lvl,
                    flags: [p.kick, p.pierce, p.remote, p.line, p.punch],
                },
            );
        }
    }

    /// Finds an open cell away from bombs, fire and other players, with room
    /// to escape from a first bomb. Carves space as a last resort.
    pub(super) fn find_spawn(&mut self) -> (i32, i32) {
        for attempt in 0..400 {
            let x = self.rng.between(1, self.map.w - 2);
            let y = self.rng.between(1, self.map.h - 2);
            if self.spawn_ok(x, y, attempt < 300) {
                return (x, y);
            }
        }
        self.carve_spawn()
    }

    /// Like `find_spawn`, but close to a friend.
    pub(super) fn find_spawn_near(&mut self, nx: i32, ny: i32) -> (i32, i32) {
        for _ in 0..200 {
            let x = nx + self.rng.between(-5, 5);
            let y = ny + self.rng.between(-5, 5);
            if self.map.in_bounds(x, y) && self.spawn_ok(x, y, false) {
                return (x, y);
            }
        }
        self.find_spawn()
    }

    pub(super) fn spawn_ok(&self, x: i32, y: i32, avoid_players: bool) -> bool {
        if self.map.is_solid(x, y) || self.bomb_at(x, y).is_some() || self.map.get(x, y) == Tile::Teleport || self.sudden_death_unsafe(x, y) {
            return false;
        }
        if self.danger_near(x, y, 4) {
            return false;
        }
        if avoid_players && self.players_in_rect(x - 3, y - 3, x + 3, y + 3).any(|p| p.alive) {
            return false;
        }
        self.map.open_cells_near(x, y) >= 4
    }

    /// Picks a lane intersection and clears the crates around it.
    pub(super) fn carve_spawn(&mut self) -> (i32, i32) {
        let x = self.rng.between(0, (self.map.w - 3) / 2) * 2 + 1;
        let y = self.rng.between(0, (self.map.h - 3) / 2) * 2 + 1;
        for (dx, dy) in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (2, 0), (0, 2)] {
            let (cx, cy) = (x + dx, y + dy);
            if self.map.get(cx, cy).is_breakable() {
                self.set_tile(cx, cy, Tile::Floor);
            }
        }
        (x, y)
    }

    pub(super) fn danger_near(&self, x: i32, y: i32, r: i32) -> bool {
        for cy in (y - r).max(0)..=(y + r).min(self.map.h - 1) {
            for cx in (x - r).max(0)..=(x + r).min(self.map.w - 1) {
                let i = self.map.idx(cx, cy);
                if self.bomb_grid[i] != 0 || self.flame_until[i] > self.tick {
                    return true;
                }
            }
        }
        false
    }
}
