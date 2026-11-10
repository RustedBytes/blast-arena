//! Clones: a decoy double that replays its owner's movement from a couple
//! of seconds ago. It looks like the owner but can't hurt anyone, pick
//! anything up, use portals or be stuck to; a blast destroys it.
//!
//! Every player keeps a ring buffer of recent movement ([`History`]), one
//! frame per tick, written at the end of their movement step. A clone
//! shows the frame from `playbackDelay` ticks ago, but the server keeps it
//! honest against today's map: it never walks into a cell that has become
//! solid since, and it won't skip over cells (a teleport in the recording),
//! so it waits where it is until the recording comes back next to it.

use super::abilities::{Audience, ab, reject};
use super::map::Tile;
use super::World;

/// Ticks of movement remembered per player (3.2 s at 20 Hz).
pub const HISTORY_TICKS: usize = 64;

/// Frame flags.
pub const F_MOVING: u8 = 1;
pub const F_JUMPING: u8 = 2;
pub const F_DASHING: u8 = 4;
/// A bomb was placed this tick.
pub const F_BOMB: u8 = 8;

/// One tick of a player's movement.
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Frame {
    pub tick: u64,
    pub x: f32,
    pub y: f32,
    pub facing: u8,
    pub flags: u8,
}

/// A ring buffer of recent frames, indexed by tick. Boxed so a `Player`
/// stays small to move around.
pub struct History {
    frames: Box<[Frame; HISTORY_TICKS]>,
}

impl Default for History {
    fn default() -> Self {
        History { frames: Box::new([Frame::default(); HISTORY_TICKS]) }
    }
}

impl History {
    pub fn record(&mut self, f: Frame) {
        self.frames[(f.tick % HISTORY_TICKS as u64) as usize] = f;
    }

    /// The frame recorded at `tick`, if it's still remembered.
    #[must_use]
    pub fn at(&self, tick: u64) -> Option<Frame> {
        let f = self.frames[(tick % HISTORY_TICKS as u64) as usize];
        (f.tick == tick && tick != 0).then_some(f)
    }

    pub fn clear(&mut self) {
        self.frames.fill(Frame::default());
    }
}

pub struct Clone {
    pub id: u32,
    pub owner: u32,
    pub x: f32,
    pub y: f32,
    pub facing: u8,
    pub flags: u8,
    /// The recording plays from this tick on (spawn tick - delay).
    pub delay: u64,
    pub until: u64,
}

/// A clone's fake bomb: only a picture, gone after a second.
pub struct Decoy {
    pub id: u32,
    pub owner: u32,
    pub x: i32,
    pub y: i32,
    /// Fuse shown, as a real bomb's would be.
    pub fuse_at: u64,
    pub until: u64,
}

impl World {
    /// Records a player's movement this tick for their clones.
    pub(super) fn record_history(&mut self, id: u32, bombed: bool) {
        let tick = self.tick;
        let p = self.players.get_mut(&id).unwrap();
        let flags = (u8::from(p.moving) * F_MOVING)
            | (u8::from(p.jump_left > 0) * F_JUMPING)
            | (u8::from(p.dashing()) * F_DASHING)
            | (u8::from(bombed) * F_BOMB);
        let (x, y, facing) = (p.x, p.y, p.facing);
        p.history.record(Frame { tick, x, y, facing, flags });
    }

    /// `activate`: a clone appears where the player was `playbackDelay`
    /// ago. Refused (free of charge) without that much history, or when
    /// that spot is solid now.
    pub(super) fn spawn_clone(&mut self, id: u32) -> Result<bool, i64> {
        let max = usize::from(self.tuning.raw.clone.max_active);
        if self.clones.iter().filter(|c| c.owner == id).count() >= max {
            return Err(reject::LIMIT);
        }
        let delay = self.tuning.clone_delay;
        let Some(f) = self.tick.checked_sub(delay).and_then(|t| self.players[&id].history.at(t)) else {
            return Err(reject::NO_HISTORY);
        };
        let (cx, cy) = (f.x.floor() as i32, f.y.floor() as i32);
        if self.map.is_solid(cx, cy) {
            return Err(reject::NO_HISTORY);
        }
        let cid = self.next_object_id();
        let until = self.tick + self.tuning.clone_ticks;
        self.clones.push(Clone { id: cid, owner: id, x: f.x, y: f.y, facing: f.facing, flags: f.flags & !F_BOMB, delay, until });
        self.stats.clones += 1;
        self.ability_event(ab::CLONE_SPAWNED, Audience::Team(id), &[i64::from(cid), i64::from(id), i64::from(cx), i64::from(cy)]);
        Ok(true)
    }

    /// Clones replay their recording, blow up in fire and expire; decoy
    /// bombs fade. Runs after the fuses, so this tick's blasts count.
    pub(super) fn update_clones(&mut self) {
        let tick = self.tick;
        self.decoys.retain(|d| d.until > tick);
        let mut k = 0;
        while k < self.clones.len() {
            let (cid, owner, delay) = (self.clones[k].id, self.clones[k].owner, self.clones[k].delay);
            let alive = self.players.get(&owner).is_some_and(|p| p.alive);
            let (cx, cy) = (self.clones[k].x.floor() as i32, self.clones[k].y.floor() as i32);
            let reason = if !alive {
                Some(0)
            } else if self.flame_active(cx, cy) {
                Some(1)
            } else if self.clones[k].until <= tick {
                Some(0)
            } else {
                None
            };
            if let Some(r) = reason {
                self.clones.swap_remove(k);
                self.ability_event(ab::CLONE_DESTROYED, Audience::Near(cx, cy), &[i64::from(cid), i64::from(cx), i64::from(cy), r]);
                continue;
            }
            let frame = tick.checked_sub(delay).and_then(|t| self.players[&owner].history.at(t));
            if let Some(f) = frame {
                let (nx, ny) = (f.x.floor() as i32, f.y.floor() as i32);
                // Mid-hop the recording passes over a pillar.
                let hopping = f.flags & F_JUMPING != 0 && self.map.get(nx, ny) == Tile::Wall;
                let reachable = (nx - cx).abs() + (ny - cy).abs() <= 1 && (hopping || !self.map.is_solid(nx, ny));
                let c = &mut self.clones[k];
                if reachable {
                    (c.x, c.y, c.facing, c.flags) = (f.x, f.y, f.facing, f.flags & !F_BOMB);
                } else {
                    c.flags &= !(F_MOVING | F_DASHING);
                }
                if reachable && f.flags & F_BOMB != 0 {
                    let did = self.next_object_id();
                    let show = self.tuning.decoy_ticks;
                    self.decoys.push(Decoy { id: did, owner, x: nx, y: ny, fuse_at: tick + super::bomb::FUSE_TICKS, until: tick + show });
                }
            } else {
                self.clones[k].flags &= !(F_MOVING | F_DASHING);
            }
            k += 1;
        }
    }

    /// Removes `owner`'s clones (1 in `reason`: blown up).
    pub(super) fn remove_clones_of(&mut self, owner: u32, reason: i64) {
        while let Some(k) = self.clones.iter().position(|c| c.owner == owner) {
            let c = self.clones.swap_remove(k);
            let (x, y) = (c.x.floor() as i32, c.y.floor() as i32);
            self.ability_event(ab::CLONE_DESTROYED, Audience::Near(x, y), &[i64::from(c.id), i64::from(x), i64::from(y), reason]);
        }
        self.decoys.retain(|d| d.owner != owner);
    }

    pub(super) fn clear_clones(&mut self) {
        let owners: Vec<u32> = self.clones.iter().map(|c| c.owner).collect();
        for o in owners {
            self.remove_clones_of(o, 0);
        }
        self.decoys.clear();
    }
}
