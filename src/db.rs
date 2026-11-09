//! Persistent player profiles in SQLite.
//!
//! The database runs on its own blocking thread; the game and the HTTP
//! handlers talk to it through a channel, so a slow disk never stalls a
//! tick. A profile is keyed by a random token the browser keeps.

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Profile {
    #[serde(skip)]
    pub token: String,
    pub name: String,
    pub kills: u64,
    pub deaths: u64,
    /// Rounds finished as MVP.
    pub wins: u64,
    pub xp: u64,
    pub best_streak: u64,
    pub games: u64,
    pub hat: u8,
    pub trail: u8,
}

/// Hats in order; each unlocks at the level beside it.
pub const HAT_LEVELS: [u32; 7] = [1, 2, 3, 5, 7, 9, 12];
/// Trails; 0 is "none".
pub const TRAIL_LEVELS: [u32; 4] = [1, 4, 8, 11];

pub fn level(xp: u64) -> u32 {
    ((xp as f64 / 50.0).sqrt()) as u32 + 1
}

/// XP needed to reach `level`.
pub fn xp_for_level(level: u32) -> u64 {
    let l = level.saturating_sub(1) as u64;
    l * l * 50
}

impl Profile {
    pub fn level(&self) -> u32 {
        level(self.xp)
    }

    /// The cosmetic choice if unlocked, otherwise none.
    pub fn allowed_hat(&self, hat: u8) -> u8 {
        if HAT_LEVELS.get(hat as usize).is_some_and(|&l| self.level() >= l) { hat } else { 0 }
    }

    pub fn allowed_trail(&self, trail: u8) -> u8 {
        if TRAIL_LEVELS.get(trail as usize).is_some_and(|&l| self.level() >= l) { trail } else { 0 }
    }
}

pub fn valid_token(token: &str) -> bool {
    (8..=64).contains(&token.len()) && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

enum Op {
    Load { token: String, reply: oneshot::Sender<Option<Profile>> },
    Save(Profile),
    Top { limit: u32, reply: oneshot::Sender<Vec<Profile>> },
}

/// Cheap, cloneable handle to the profile database.
#[derive(Clone)]
pub struct Db {
    tx: mpsc::Sender<Op>,
}

impl Db {
    /// Opens (or creates) the database and starts its worker thread.
    pub fn open(path: &str) -> rusqlite::Result<Db> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS profiles (
                 token TEXT PRIMARY KEY,
                 name TEXT NOT NULL,
                 kills INTEGER NOT NULL DEFAULT 0,
                 deaths INTEGER NOT NULL DEFAULT 0,
                 wins INTEGER NOT NULL DEFAULT 0,
                 xp INTEGER NOT NULL DEFAULT 0,
                 best_streak INTEGER NOT NULL DEFAULT 0,
                 games INTEGER NOT NULL DEFAULT 0,
                 hat INTEGER NOT NULL DEFAULT 0,
                 trail INTEGER NOT NULL DEFAULT 0,
                 updated INTEGER NOT NULL DEFAULT (strftime('%s','now'))
             );
             CREATE INDEX IF NOT EXISTS profiles_xp ON profiles(xp DESC);",
        )?;
        let (tx, mut rx) = mpsc::channel::<Op>(4096);
        std::thread::Builder::new()
            .name("profile-db".into())
            .spawn(move || {
                while let Some(op) = rx.blocking_recv() {
                    if let Err(e) = run(&conn, op) {
                        tracing::warn!("profile db error: {e}");
                    }
                }
            })
            .expect("spawn db thread");
        Ok(Db { tx })
    }

    pub async fn load(&self, token: &str) -> Option<Profile> {
        let (reply, rx) = oneshot::channel();
        self.tx.send(Op::Load { token: token.to_string(), reply }).await.ok()?;
        rx.await.ok().flatten()
    }

    /// Queues a save without waiting; dropped if the queue is full.
    pub fn save(&self, profile: Profile) {
        let _ = self.tx.try_send(Op::Save(profile));
    }

    pub async fn top(&self, limit: u32) -> Vec<Profile> {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Op::Top { limit, reply }).await.is_err() {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }
}

fn row_to_profile(r: &rusqlite::Row) -> rusqlite::Result<Profile> {
    Ok(Profile {
        token: r.get(0)?,
        name: r.get(1)?,
        kills: r.get::<_, i64>(2)? as u64,
        deaths: r.get::<_, i64>(3)? as u64,
        wins: r.get::<_, i64>(4)? as u64,
        xp: r.get::<_, i64>(5)? as u64,
        best_streak: r.get::<_, i64>(6)? as u64,
        games: r.get::<_, i64>(7)? as u64,
        hat: r.get(8)?,
        trail: r.get(9)?,
    })
}

const COLUMNS: &str = "token, name, kills, deaths, wins, xp, best_streak, games, hat, trail";

fn run(conn: &Connection, op: Op) -> rusqlite::Result<()> {
    match op {
        Op::Load { token, reply } => {
            let p = conn
                .query_row(&format!("SELECT {COLUMNS} FROM profiles WHERE token = ?1"), [&token], row_to_profile)
                .optional()?;
            let _ = reply.send(p);
        }
        Op::Save(p) => {
            conn.execute(
                "INSERT INTO profiles (token, name, kills, deaths, wins, xp, best_streak, games, hat, trail, updated)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, strftime('%s','now'))
                 ON CONFLICT(token) DO UPDATE SET name = ?2, kills = ?3, deaths = ?4, wins = ?5, xp = ?6,
                     best_streak = ?7, games = ?8, hat = ?9, trail = ?10, updated = strftime('%s','now')",
                params![
                    p.token,
                    p.name,
                    p.kills as i64,
                    p.deaths as i64,
                    p.wins as i64,
                    p.xp as i64,
                    p.best_streak as i64,
                    p.games as i64,
                    p.hat,
                    p.trail
                ],
            )?;
        }
        Op::Top { limit, reply } => {
            let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM profiles ORDER BY xp DESC, kills DESC LIMIT ?1"))?;
            let rows = stmt.query_map([limit], row_to_profile)?.collect::<rusqlite::Result<Vec<_>>>()?;
            let _ = reply.send(rows);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_and_unlocks() {
        assert_eq!(level(0), 1);
        assert_eq!(level(49), 1);
        assert_eq!(level(50), 2);
        assert_eq!(level(xp_for_level(9)), 9);
        let p = Profile { xp: xp_for_level(5), ..Default::default() };
        assert_eq!(p.allowed_hat(3), 3, "level 5 unlocks hat 3");
        assert_eq!(p.allowed_hat(6), 0, "hat 6 needs level 12");
        assert_eq!(p.allowed_trail(1), 1);
        assert_eq!(p.allowed_trail(2), 0);
        assert_eq!(p.allowed_hat(99), 0);
    }

    #[test]
    fn tokens_are_validated() {
        assert!(valid_token("abcd-1234-efgh"));
        assert!(!valid_token("short"));
        assert!(!valid_token("has spaces in it"));
        assert!(!valid_token("drop'table--------"));
    }

    #[tokio::test]
    async fn profiles_round_trip() {
        let dir = std::env::temp_dir().join(format!("blast-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let db = Db::open(dir.to_str().unwrap()).unwrap();
        assert_eq!(db.load("token-aaaa-1").await, None);
        let p = Profile { token: "token-aaaa-1".into(), name: "Ann".into(), kills: 3, xp: 120, hat: 2, ..Default::default() };
        db.save(p.clone());
        db.save(Profile { token: "token-bbbb-2".into(), name: "Bob".into(), xp: 900, ..Default::default() });
        assert_eq!(db.load("token-aaaa-1").await, Some(p));
        let top = db.top(10).await;
        assert_eq!(top.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Bob", "Ann"]);
    }
}
