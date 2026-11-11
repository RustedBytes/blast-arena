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

#[must_use]
pub fn level(xp: u64) -> u32 {
    ((xp as f64 / 50.0).sqrt()) as u32 + 1
}

/// XP needed to reach `level`.
#[must_use]
pub fn xp_for_level(level: u32) -> u64 {
    let l = u64::from(level.saturating_sub(1));
    l * l * 50
}

impl Profile {
    #[must_use]
    pub fn level(&self) -> u32 {
        level(self.xp)
    }

    /// The cosmetic choice if unlocked, otherwise none.
    #[must_use]
    pub fn allowed_hat(&self, hat: u8) -> u8 {
        if HAT_LEVELS.get(hat as usize).is_some_and(|&l| self.level() >= l) { hat } else { 0 }
    }

    #[must_use]
    pub fn allowed_trail(&self, trail: u8) -> u8 {
        if TRAIL_LEVELS.get(trail as usize).is_some_and(|&l| self.level() >= l) { trail } else { 0 }
    }
}

#[must_use]
pub fn valid_token(token: &str) -> bool {
    (8..=64).contains(&token.len()) && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

enum Op {
    Load { token: String, reply: oneshot::Sender<Option<Profile>> },
    Save(Profile),
    Top { limit: u32, reply: oneshot::Sender<Vec<Profile>> },
}

impl Op {
    fn kind(&self) -> &'static str {
        match self {
            Op::Load { .. } => "load",
            Op::Save(_) => "save",
            Op::Top { .. } => "top",
        }
    }
}

/// Cheap, cloneable handle to the profile database.
#[derive(Clone)]
pub struct Db {
    tx: mpsc::Sender<Op>,
}

impl Db {
    /// Opens (or creates) the database and starts its worker thread.
    ///
    /// # Errors
    /// If the file can't be opened or the schema can't be created.
    ///
    /// # Panics
    /// If the operating system refuses to start the worker thread.
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
        let profiles: i64 = conn.query_row("SELECT COUNT(*) FROM profiles", [], |r| r.get(0))?;
        tracing::info!("profile database {path} opened with {profiles} profiles");
        let (tx, mut rx) = mpsc::channel::<Op>(4096);
        std::thread::Builder::new()
            .name("profile-db".into())
            .spawn(move || {
                while let Some(op) = rx.blocking_recv() {
                    let kind = op.kind();
                    if let Err(e) = run(&conn, op) {
                        tracing::error!("profile db {kind} failed: {e}");
                    }
                }
                tracing::debug!("profile db thread stopped");
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
        if let Err(e) = self.tx.try_send(Op::Save(profile)) {
            tracing::warn!("profile save dropped: {}", if matches!(e, mpsc::error::TrySendError::Full(_)) { "queue full" } else { "db closed" });
        }
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
    // SQLite integers are signed. A negative count (a corrupted or
    // hand-edited row) reads as 0 instead of wrapping to a huge number.
    let count = |i| r.get::<_, i64>(i).map(|v| u64::try_from(v).unwrap_or(0));
    Ok(Profile {
        token: r.get(0)?,
        name: r.get(1)?,
        kills: count(2)?,
        deaths: count(3)?,
        wins: count(4)?,
        xp: count(5)?,
        best_streak: count(6)?,
        games: count(7)?,
        hat: r.get(8)?,
        trail: r.get(9)?,
    })
}

/// A count as a SQLite integer, saturating rather than wrapping.
fn sql_count(v: u64) -> i64 {
    i64::try_from(v).unwrap_or(i64::MAX)
}

const COLUMNS: &str = "token, name, kills, deaths, wins, xp, best_streak, games, hat, trail";

fn run(conn: &Connection, op: Op) -> rusqlite::Result<()> {
    match op {
        Op::Load { token, reply } => {
            let p = conn
                .query_row(&format!("SELECT {COLUMNS} FROM profiles WHERE token = ?1"), [&token], row_to_profile)
                .optional()?;
            tracing::debug!("profile loaded: {}", if p.is_some() { "existing" } else { "new player" });
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
                    sql_count(p.kills),
                    sql_count(p.deaths),
                    sql_count(p.wins),
                    sql_count(p.xp),
                    sql_count(p.best_streak),
                    sql_count(p.games),
                    p.hat,
                    p.trail
                ],
            )?;
            tracing::debug!("profile saved for {} (level {}, xp {})", p.name, p.level(), p.xp);
        }
        Op::Top { limit, reply } => {
            // Ranked by XP (what the lobby list shows); ties go to more wins,
            // then more kills, then fewer deaths. Profiles that never earned
            // XP aren't records.
            let mut stmt = conn.prepare(&format!(
                "SELECT {COLUMNS} FROM profiles WHERE xp > 0
                 ORDER BY xp DESC, wins DESC, kills DESC, deaths ASC LIMIT ?1"
            ))?;
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
        let _ = std::fs::remove_file(&dir);
    }

    #[tokio::test]
    async fn leaderboard_order() {
        let dir = std::env::temp_dir().join(format!("blast-top-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let db = Db::open(dir.to_str().unwrap()).unwrap();
        let save = |name: &str, xp, wins, kills, deaths| {
            db.save(Profile { token: format!("token-{name}-0000"), name: name.into(), xp, wins, kills, deaths, ..Default::default() });
        };
        save("idle", 0, 0, 0, 0); // never earned XP: not listed
        save("low", 10, 0, 1, 5);
        save("careful", 10, 0, 1, 1); // same XP and kills, fewer deaths
        save("winner", 10, 1, 0, 9); // same XP, a win
        save("top", 40, 0, 4, 15);
        let top = db.top(10).await;
        assert_eq!(top.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["top", "winner", "careful", "low"]);
        let _ = std::fs::remove_file(&dir);
    }
}
