//! Persistent player profiles in redb, a pure-Rust embedded database.
//!
//! The database runs on its own blocking thread; the game and the HTTP
//! handlers talk to it through a channel, so a slow disk never stalls a
//! tick. A profile is keyed by a random token the browser keeps.

use std::io::Read as _;

use redb::{Database, ReadableDatabase as _, ReadableTable as _, ReadableTableMetadata as _, TableDefinition};
use serde::{Deserialize, Serialize};
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

/// Token → the profile as a `MessagePack` map (see [`Record`]).
const PROFILES: TableDefinition<&str, &[u8]> = TableDefinition::new("profiles");
/// The leaderboard index: one key per profile with XP, in rank order.
/// Counts are stored inverted (`!x`) so an ascending scan gives XP, wins
/// and kills descending; deaths stay ascending; the token breaks ties.
const RANKING: TableDefinition<RankKey, ()> = TableDefinition::new("ranking");
type RankKey = (u64, u64, u64, u64, &'static str);

/// A profile as stored. Named `MessagePack` fields with defaults, so fields
/// can be added later without breaking older files.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Record {
    name: String,
    kills: u64,
    deaths: u64,
    wins: u64,
    xp: u64,
    best_streak: u64,
    games: u64,
    hat: u8,
    trail: u8,
    /// Unix seconds of the last save.
    updated: u64,
}

impl Record {
    fn from_profile(p: &Profile) -> Record {
        let updated = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
        Record {
            name: p.name.clone(),
            kills: p.kills,
            deaths: p.deaths,
            wins: p.wins,
            xp: p.xp,
            best_streak: p.best_streak,
            games: p.games,
            hat: p.hat,
            trail: p.trail,
            updated,
        }
    }

    fn into_profile(self, token: String) -> Profile {
        Profile {
            token,
            name: self.name,
            kills: self.kills,
            deaths: self.deaths,
            wins: self.wins,
            xp: self.xp,
            best_streak: self.best_streak,
            games: self.games,
            hat: self.hat,
            trail: self.trail,
        }
    }
}

fn rank_key(token: &str, xp: u64, wins: u64, kills: u64, deaths: u64) -> (u64, u64, u64, u64, &str) {
    (!xp, !wins, !kills, deaths, token)
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Cheap, cloneable handle to the profile database.
#[derive(Clone)]
pub struct Db {
    tx: mpsc::Sender<Op>,
}

impl Db {
    /// Opens (or creates) the database and starts its worker thread.
    ///
    /// # Errors
    /// If the file can't be opened or created (wrong owner or permissions:
    /// saves would fail), is an old SQLite profile file, or isn't a valid
    /// redb file.
    ///
    /// # Panics
    /// If the operating system refuses to start the worker thread.
    pub fn open(path: &str) -> Result<Db, BoxError> {
        refuse_sqlite(path)?;
        let db = Database::create(path).map_err(|e| match e {
            redb::DatabaseError::Storage(redb::StorageError::Io(io)) if io.kind() == std::io::ErrorKind::PermissionDenied => {
                format!("{path} is read-only for this process (check its owner and permissions, and its directory's): {io}").into()
            }
            e => BoxError::from(e),
        })?;
        // Create both tables up front, so reads never meet a missing table.
        let txn = db.begin_write()?;
        let profiles = txn.open_table(PROFILES)?.len()?;
        txn.open_table(RANKING)?;
        txn.commit()?;
        tracing::info!("profile database {path} opened with {profiles} profiles");
        let (tx, mut rx) = mpsc::channel::<Op>(4096);
        std::thread::Builder::new()
            .name("profile-db".into())
            .spawn(move || {
                while let Some(op) = rx.blocking_recv() {
                    let kind = op.kind();
                    if let Err(e) = run(&db, op) {
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

/// Profiles used to live in SQLite, often at the same path. Opening such a
/// file as redb fails with an obscure format error; say what it is instead.
fn refuse_sqlite(path: &str) -> Result<(), BoxError> {
    let mut magic = [0u8; 16];
    let is_sqlite = std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && &magic == b"SQLite format 3\0";
    if is_sqlite {
        return Err(format!("{path} is a SQLite profile file from an older version; profiles are now stored with redb, so move it aside or point --db at a new file").into());
    }
    Ok(())
}

fn decode(token: &str, bytes: &[u8]) -> Result<Profile, BoxError> {
    Ok(rmp_serde::from_slice::<Record>(bytes)?.into_profile(token.to_string()))
}

fn run(db: &Database, op: Op) -> Result<(), BoxError> {
    match op {
        Op::Load { token, reply } => {
            let txn = db.begin_read()?;
            let table = txn.open_table(PROFILES)?;
            let p = table.get(token.as_str())?.map(|v| decode(&token, v.value())).transpose()?;
            tracing::debug!("profile loaded: {}", if p.is_some() { "existing" } else { "new player" });
            let _ = reply.send(p);
        }
        Op::Save(p) => {
            let bytes = rmp_serde::to_vec_named(&Record::from_profile(&p))?;
            let txn = db.begin_write()?;
            {
                let mut profiles = txn.open_table(PROFILES)?;
                let mut ranking = txn.open_table(RANKING)?;
                // The old ranking entry goes, or the player would be listed twice.
                let old = profiles.insert(p.token.as_str(), bytes.as_slice())?.map(|v| rmp_serde::from_slice::<Record>(v.value()));
                if let Some(Ok(o)) = old {
                    ranking.remove(rank_key(&p.token, o.xp, o.wins, o.kills, o.deaths))?;
                }
                // Profiles that never earned XP aren't records.
                if p.xp > 0 {
                    ranking.insert(rank_key(&p.token, p.xp, p.wins, p.kills, p.deaths), ())?;
                }
            }
            txn.commit()?;
            tracing::debug!("profile saved for {} (level {}, xp {})", p.name, p.level(), p.xp);
        }
        Op::Top { limit, reply } => {
            // Ranked by XP (what the lobby list shows); ties go to more wins,
            // then more kills, then fewer deaths.
            let txn = db.begin_read()?;
            let ranking = txn.open_table(RANKING)?;
            let profiles = txn.open_table(PROFILES)?;
            let mut rows = Vec::new();
            for entry in ranking.iter()?.take(limit as usize) {
                let (key, ()) = entry.map(|(k, v)| (k, v.value()))?;
                let token = key.value().4;
                if let Some(v) = profiles.get(token)? {
                    rows.push(decode(token, v.value())?);
                }
            }
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

    #[cfg(unix)]
    #[tokio::test]
    async fn read_only_files_are_refused() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("blast-ro-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        drop(Db::open(dir.to_str().unwrap()).unwrap());
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o444)).unwrap();
        let err = Db::open(dir.to_str().unwrap()).err().expect("a read-only file is refused");
        assert!(err.to_string().contains("read-only"), "{err}");
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

    #[tokio::test]
    async fn resaving_moves_the_ranking_entry() {
        let dir = std::env::temp_dir().join(format!("blast-rerank-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&dir);
        let db = Db::open(dir.to_str().unwrap()).unwrap();
        let p = Profile { token: "token-cccc-3".into(), name: "Cy".into(), xp: 10, ..Default::default() };
        db.save(p.clone());
        db.save(Profile { token: "token-dddd-4".into(), name: "Di".into(), xp: 20, ..Default::default() });
        db.save(Profile { xp: 30, kills: 2, ..p });
        let top = db.top(10).await;
        assert_eq!(top.iter().map(|p| (p.name.as_str(), p.xp)).collect::<Vec<_>>(), [("Cy", 30), ("Di", 20)]);
        drop(db);
        // Reopened, the data is still there (once the worker lets go of the file).
        let mut reopened = Db::open(dir.to_str().unwrap());
        for _ in 0..100 {
            if reopened.is_ok() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            reopened = Db::open(dir.to_str().unwrap());
        }
        let db = reopened.unwrap();
        assert_eq!(db.load("token-cccc-3").await.map(|p| p.kills), Some(2));
        let _ = std::fs::remove_file(&dir);
    }

    #[test]
    fn old_sqlite_files_are_refused() {
        let dir = std::env::temp_dir().join(format!("blast-sqlite-{}.db", std::process::id()));
        std::fs::write(&dir, b"SQLite format 3\0rest of the header").unwrap();
        let err = Db::open(dir.to_str().unwrap()).err().expect("a SQLite file is refused");
        assert!(err.to_string().contains("SQLite"), "{err}");
        let _ = std::fs::remove_file(&dir);
    }
}
