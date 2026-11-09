use axum::extract::ws::Utf8Bytes;
use tokio::sync::mpsc;

/// Direction vectors indexed by the protocol direction code:
/// 0 = none, 1 = up, 2 = right, 3 = down, 4 = left.
pub const DIRS: [(i32, i32); 5] = [(0, 0), (0, -1), (1, 0), (0, 1), (-1, 0)];

pub const BASE_BOMBS: u8 = 1;
pub const BASE_RANGE: u8 = 2;
pub const MAX_BOMBS: u8 = 8;
pub const MAX_RANGE: u8 = 8;
pub const MAX_SPEED_LVL: u8 = 6;
const BASE_SPEED: f32 = 3.5; // tiles per second
const SPEED_STEP: f32 = 0.6;

/// How far off a lane the player must be before corner assist kicks in.
const CORNER_ASSIST_MIN: f32 = 0.12;

pub struct Player {
    pub id: u32,
    pub name: String,
    pub tx: mpsc::Sender<Utf8Bytes>,
    /// Centre of the player in tile units (tile (3,4) spans 3.0..4.0).
    pub x: f32,
    pub y: f32,
    pub input_dir: u8,
    pub facing: u8,
    pub moving: bool,
    pub want_bomb: bool,
    pub alive: bool,
    pub respawn_at: u64,
    pub invulnerable_until: u64,
    pub killed_by: Option<u32>,
    pub max_bombs: u8,
    pub range: u8,
    pub speed_lvl: u8,
    pub kick: bool,
    pub active_bombs: u8,
    pub score: i32,
    pub kills: u32,
    pub deaths: u32,
}

impl Player {
    pub fn new(id: u32, name: String, tx: mpsc::Sender<Utf8Bytes>) -> Self {
        Player {
            id,
            name,
            tx,
            x: 1.5,
            y: 1.5,
            input_dir: 0,
            facing: 3,
            moving: false,
            want_bomb: false,
            alive: false,
            respawn_at: 0,
            invulnerable_until: 0,
            killed_by: None,
            max_bombs: BASE_BOMBS,
            range: BASE_RANGE,
            speed_lvl: 0,
            kick: false,
            active_bombs: 0,
            score: 0,
            kills: 0,
            deaths: 0,
        }
    }

    pub fn cell(&self) -> (i32, i32) {
        (self.x.floor() as i32, self.y.floor() as i32)
    }

    pub fn speed(&self) -> f32 {
        BASE_SPEED + SPEED_STEP * self.speed_lvl as f32
    }

    pub fn reset_stats(&mut self) {
        self.max_bombs = BASE_BOMBS;
        self.range = BASE_RANGE;
        self.speed_lvl = 0;
        self.kick = false;
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
        if !cell_at(cm + step, cs) {
            // Ease onto the lane first; leftover distance goes forward.
            let a = rem.min(off.abs());
            *side -= a * off.signum();
            rem -= a;
            if rem <= 0.0 {
                return;
            }
        } else {
            let ns = cs + off.signum() as i32;
            if off.abs() >= CORNER_ASSIST_MIN && !cell_at(cm + step, ns) && !cell_at(cm, ns) {
                let to_lane = 1.0 - off.abs();
                *side += rem.min(to_lane) * off.signum();
            }
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
