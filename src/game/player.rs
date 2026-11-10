use super::link::ClientLink;
use crate::db::Profile;

/// Direction vectors indexed by the protocol direction code:
/// 0 = none, 1 = up, 2 = right, 3 = down, 4 = left.
pub const DIRS: [(i32, i32); 5] = [(0, 0), (0, -1), (1, 0), (0, 1), (-1, 0)];
/// Opposite of each direction code (used by the reversed-controls curse).
pub const OPPOSITE: [u8; 5] = [0, 3, 4, 1, 2];

pub const BASE_BOMBS: u8 = 1;
pub const BASE_RANGE: u8 = 2;
pub const MAX_BOMBS: u8 = 8;
pub const MAX_RANGE: u8 = 8;
pub const MAX_SPEED_LVL: u8 = 6;
/// Atomic bombs a player can carry at once.
pub const MAX_NUKES: u8 = 2;
/// Gadget charges a player can hold.
pub const MAX_GADGET_CHARGES: u8 = 9;
pub const BASE_SPEED: f32 = 3.5; // tiles per second
pub const SPEED_STEP: f32 = 0.6;
/// Speed while under the slow curse.
pub const CURSED_SPEED: f32 = 2.2;
/// Default half extents of the area a client receives updates for, and the
/// range a client may request when zooming.
pub const AOI_DEFAULT: (i32, i32) = (16, 12);
pub const AOI_MIN: (i32, i32) = (6, 5);
pub const AOI_MAX: (i32, i32) = (26, 18);

/// Jumping over a stone pillar: the hop takes `JUMP_TICKS` and covers
/// `JUMP_CELLS` (from the cell centre in front of the pillar to the one
/// behind it); then there's a cooldown. Anywhere in the cell will do
/// (`JUMP_LANE_SLACK` is half a cell): the hop starts from its centre.
pub const JUMP_TICKS: u8 = 8;
pub const JUMP_CELLS: f32 = 2.0;
pub const JUMP_COOLDOWN_TICKS: u64 = 10;
pub const JUMP_LANE_SLACK: f32 = 0.5;

/// How far off a lane the player must be before corner assist kicks in.
const CORNER_ASSIST_MIN: f32 = 0.12;

#[allow(clippy::struct_excessive_bools, reason = "independent power-up and state flags")]
pub struct Player {
    pub id: u32,
    pub name: String,
    /// Connection to the client; `None` for server-side bots.
    pub link: Option<ClientLink>,
    /// Persistent identity of a human player (their profile key).
    pub token: Option<String>,
    pub profile: Option<Profile>,
    pub profile_dirty: bool,
    /// Team in team mode (1 red, 2 blue); 0 in free-for-all.
    pub team: u8,
    /// Cosmetics: hat and trail ids.
    pub hat: u8,
    pub trail: u8,
    /// Centre of the player in tile units (tile (3,4) spans 3.0..4.0).
    pub x: f32,
    pub y: f32,
    pub input_dir: u8,
    /// Fallback direction tried when `input_dir` is blocked (turn buffering).
    pub input_alt: u8,
    /// The jump key is held.
    pub input_jump: bool,
    /// Direction of the hop in progress (0 on the ground) and ticks left.
    pub jump_dir: u8,
    pub jump_left: u8,
    /// No new jump before this tick.
    pub jump_ready_at: u64,
    /// Sequence number of the newest input applied, echoed for prediction.
    pub input_seq: u16,
    /// Newest snapshot tick the client says it has decoded (0 = none).
    pub snap_ack: u32,
    /// Bomb / action / emote presses seen so far from the input slot.
    pub bomb_presses: u32,
    pub act_presses: u32,
    pub emote_seq: u32,
    /// Half extents of this player's area of interest.
    pub aoi: (i32, i32),
    pub facing: u8,
    pub moving: bool,
    /// Direction a player keeps sliding in on ice.
    pub slide_dir: u8,
    pub want_bomb: bool,
    pub want_act: bool,
    pub alive: bool,
    pub respawn_at: u64,
    pub invulnerable_until: u64,
    pub teleport_ready_at: u64,
    /// Earliest tick the next emote is accepted.
    pub next_emote_at: u64,
    pub killed_by: Option<u32>,
    pub max_bombs: u8,
    pub range: u8,
    pub speed_lvl: u8,
    pub kick: bool,
    pub pierce: bool,
    pub remote: bool,
    pub line: bool,
    pub punch: bool,
    /// Atomic bombs carried: the next bombs placed are nukes.
    pub nukes: u8,
    /// Blasts leave ice behind (freeze power-up).
    pub freeze: bool,
    /// Landing a jump stuns enemies next to you (stomp power-up).
    pub stomp: bool,
    /// The gadget held (an `Item` code, 0 for none) and its charges.
    pub gadget: u8,
    pub gadget_n: u8,
    pub gadget_presses: u32,
    pub want_gadget: bool,
    /// Stunned (by a stomp) until this tick: can't move, jump or bomb.
    pub stunned_until: u64,
    /// Team whose flag this player carries (capture the flag), 0 for none.
    pub carrying: u8,
    /// Ticks spent in the battle royale storm (wears off in the zone).
    pub storm: u16,
    pub ghost_until: u64,
    pub slow_until: u64,
    pub nobomb_until: u64,
    pub reversed_until: u64,
    pub active_bombs: u8,
    pub score: i32,
    pub kills: u32,
    pub deaths: u32,
    /// Kills since the last death.
    pub streak: u32,
    /// Leader with a price on their head.
    pub bounty: bool,
    /// Ticks spent standing on a hill towards the next point.
    pub hill_ticks: u32,
}

impl Player {
    #[must_use]
    pub fn new(id: u32, name: String, link: Option<ClientLink>) -> Self {
        Player {
            id,
            name,
            link,
            token: None,
            profile: None,
            profile_dirty: false,
            team: 0,
            hat: 0,
            trail: 0,
            x: 1.5,
            y: 1.5,
            input_dir: 0,
            input_alt: 0,
            input_jump: false,
            jump_dir: 0,
            jump_left: 0,
            jump_ready_at: 0,
            input_seq: 0,
            snap_ack: 0,
            bomb_presses: 0,
            act_presses: 0,
            emote_seq: 0,
            aoi: AOI_DEFAULT,
            facing: 3,
            moving: false,
            slide_dir: 0,
            want_bomb: false,
            want_act: false,
            alive: false,
            respawn_at: 0,
            invulnerable_until: 0,
            teleport_ready_at: 0,
            next_emote_at: 0,
            killed_by: None,
            max_bombs: BASE_BOMBS,
            range: BASE_RANGE,
            speed_lvl: 0,
            kick: false,
            pierce: false,
            remote: false,
            line: false,
            punch: false,
            nukes: 0,
            freeze: false,
            stomp: false,
            gadget: 0,
            gadget_n: 0,
            gadget_presses: 0,
            want_gadget: false,
            stunned_until: 0,
            carrying: 0,
            storm: 0,
            ghost_until: 0,
            slow_until: 0,
            nobomb_until: 0,
            reversed_until: 0,
            active_bombs: 0,
            score: 0,
            kills: 0,
            deaths: 0,
            streak: 0,
            bounty: false,
            hill_ticks: 0,
        }
    }

    #[must_use]
    pub fn cell(&self) -> (i32, i32) {
        (self.x.floor() as i32, self.y.floor() as i32)
    }

    #[must_use]
    pub fn is_bot(&self) -> bool {
        self.link.is_none()
    }

    /// Tiles per second at game tick `tick`, accounting for the slow curse.
    #[must_use]
    pub fn speed(&self, tick: u64) -> f32 {
        if self.slow_until > tick {
            CURSED_SPEED
        } else {
            BASE_SPEED + SPEED_STEP * f32::from(self.speed_lvl)
        }
    }

    #[must_use]
    pub fn can_bomb(&self, tick: u64) -> bool {
        self.alive
            && self.active_bombs < self.max_bombs
            && self.nobomb_until <= tick
            && self.jump_left == 0
            && self.stunned_until <= tick
            && self.carrying == 0
    }

    #[must_use]
    pub fn ghost(&self, tick: u64) -> bool {
        self.ghost_until > tick
    }

    /// Curse shown to clients: 0 none, 1 slow, 2 no bombs, 3 reversed
    /// controls; plus ticks left.
    #[must_use]
    pub fn curse(&self, tick: u64) -> (u8, u64) {
        if self.slow_until > tick {
            (1, self.slow_until - tick)
        } else if self.nobomb_until > tick {
            (2, self.nobomb_until - tick)
        } else if self.reversed_until > tick {
            (3, self.reversed_until - tick)
        } else {
            (0, 0)
        }
    }

    pub fn reset_stats(&mut self) {
        self.max_bombs = BASE_BOMBS;
        self.range = BASE_RANGE;
        self.speed_lvl = 0;
        self.kick = false;
        self.pierce = false;
        self.remote = false;
        self.line = false;
        self.punch = false;
        self.nukes = 0;
        self.freeze = false;
        self.stomp = false;
        (self.gadget, self.gadget_n) = (0, 0);
        self.stunned_until = 0;
        self.ghost_until = 0;
        self.slow_until = 0;
        self.nobomb_until = 0;
        self.reversed_until = 0;
    }

    /// Applies a client's requested view half-extents, clamped to the limits.
    pub fn set_aoi(&mut self, w: i32, h: i32) {
        self.aoi = (w.clamp(AOI_MIN.0, AOI_MAX.0), h.clamp(AOI_MIN.1, AOI_MAX.1));
    }

    /// Whether this player's blasts can hurt `other` (no friendly fire,
    /// but your own bombs always can).
    #[must_use]
    pub fn can_hurt(&self, other: &Player) -> bool {
        self.id == other.id || self.team == 0 || self.team != other.team
    }
}

/// Moves a point along the grid lanes by `dist` tiles in direction `dir`.
///
/// Players always travel along the centre line of a row or column. If they
/// are slightly off the lane they are first eased onto it, and when the way
/// ahead is blocked but the neighbouring lane on the side they lean towards
/// is open they slide into it (corner assist). `dist` must be < 0.5 so a
/// single step can never skip past a cell centre.
pub fn step_move(x: &mut f32, y: &mut f32, dir: u8, dist: f32, blocked: impl Fn(i32, i32) -> bool) {
    let (dx, dy) = DIRS[dir as usize];
    if dx == 0 && dy == 0 {
        return;
    }
    // Work in a frame where `main` is the axis of travel and `side` the other.
    let horizontal = dx != 0;
    let step = if horizontal { dx } else { dy };
    let (main, side) = if horizontal { (x, y) } else { (y, x) };
    let cell_at = |m: i32, s: i32| if horizontal { blocked(m, s) } else { blocked(s, m) };

    let cm = main.floor() as i32;
    let cs = side.floor() as i32;
    let off = *side - (cs as f32 + 0.5);
    let mut rem = dist;

    if off.abs() > 1e-4 {
        if cell_at(cm + step, cs) {
            let ns = cs + off.signum() as i32;
            if off.abs() >= CORNER_ASSIST_MIN && !cell_at(cm + step, ns) && !cell_at(cm, ns) {
                let to_lane = 1.0 - off.abs();
                *side += rem.min(to_lane) * off.signum();
            }
            return;
        }
        // Ease onto the lane first; leftover distance goes forward.
        let a = rem.min(off.abs());
        *side -= a * off.signum();
        rem -= a;
        if rem <= 0.0 {
            return;
        }
    }

    let center = cm as f32 + 0.5;
    let mut next = *main + step as f32 * rem;
    if cell_at(cm + step, cs) {
        next = if step > 0 { next.min(center.max(*main)) } else { next.max(center.min(*main)) };
    }
    *main = next;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn walls(cells: &'static [(i32, i32)]) -> impl Fn(i32, i32) -> bool {
        move |x, y| cells.contains(&(x, y))
    }

    #[test]
    fn stops_at_cell_centre_before_wall() {
        let (mut x, mut y) = (1.5, 1.5);
        let b = walls(&[(2, 1)]);
        for _ in 0..10 {
            step_move(&mut x, &mut y, 2, 0.3, &b);
        }
        assert!((x - 1.5).abs() < 1e-5);
    }

    #[test]
    fn moves_freely_through_open_cells() {
        let (mut x, mut y) = (1.5, 1.5);
        step_move(&mut x, &mut y, 2, 0.3, walls(&[]));
        assert!((x - 1.8).abs() < 1e-5 && (y - 1.5).abs() < 1e-5);
    }

    #[test]
    fn eases_onto_lane_when_off_centre() {
        // Slightly below the row centre, moving right into an open row.
        let (mut x, mut y) = (1.5, 1.6);
        step_move(&mut x, &mut y, 2, 0.3, walls(&[]));
        assert!((y - 1.5).abs() < 1e-5);
        assert!((x - 1.7).abs() < 1e-5);
    }

    #[test]
    fn corner_assist_slides_into_open_lane() {
        // Ahead in row 1 is a wall, but row 2 is open; player leans down.
        let (mut x, mut y) = (1.5, 1.8);
        let b = walls(&[(2, 1)]);
        step_move(&mut x, &mut y, 2, 0.1, &b);
        assert!(y > 1.8, "should slide toward row 2, got {y}");
        assert!((x - 1.5).abs() < 1e-5);
    }

    #[test]
    fn no_corner_assist_when_centred() {
        let (mut x, mut y) = (1.5, 1.5);
        let b = walls(&[(2, 1)]);
        step_move(&mut x, &mut y, 2, 0.1, &b);
        assert_eq!((x, y), (1.5, 1.5));
    }
}
