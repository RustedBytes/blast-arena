/// Small, fast xorshift64* generator. The game needs plenty of cheap
/// randomness but nothing cryptographic, and a seedable RNG keeps tests
/// deterministic.
pub struct Rng(u64);

impl Rng {
    #[must_use]
    pub fn new(seed: u64) -> Self {
        // Scrambled one-to-one, so every seed gives its own sequence
        // (xorshift only needs a non-zero state).
        let state = derive_seed(seed, 0);
        Rng(if state == 0 { 0x9E37_79B9_7F4A_7C15 } else { state })
    }

    #[must_use]
    pub fn from_time() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(42, |d| d.as_nanos() as u64);
        Self::new(nanos)
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform integer in `0..n` (n must be > 0).
    pub fn below(&mut self, n: u32) -> u32 {
        (((self.next_u64() >> 32) * u64::from(n)) >> 32) as u32
    }

    /// Uniform integer in `lo..=hi`.
    pub fn between(&mut self, lo: i32, hi: i32) -> i32 {
        lo + self.below((hi - lo + 1) as u32) as i32
    }

    /// Uniform float in `0.0..1.0`.
    pub fn unit(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }

    /// Uniform float in `lo..hi`.
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.unit()
    }

    /// Returns true with probability `p`.
    pub fn chance(&mut self, p: f32) -> bool {
        self.unit() < p
    }
}

/// A fresh, unpredictable seed: the system clock hashed with the
/// per-process random keys `std` draws from the OS.
#[must_use]
pub fn random_seed() -> u64 {
    use std::hash::{BuildHasher, RandomState};
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    RandomState::new().hash_one(nanos)
}

/// Derives an independent seed for stream `k` of a base seed (`SplitMix64`),
/// so arenas sharing one `--map-seed` still get different maps.
#[must_use]
pub fn derive_seed(base: u64, k: u64) -> u64 {
    let mut z = base.wrapping_add(k.wrapping_add(1).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}
