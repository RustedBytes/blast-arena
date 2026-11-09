//! Simulation benchmark: runs the world in-process with server bots and
//! simulated clients (whose snapshots are really encoded and then drained),
//! and reports time and heap allocations per tick.
//!
//! Usage: cargo run --release --bin simbench -- [--bots 200] [--clients 150] [--ticks 2000]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::Instant;

use blast_arena::game::map::Map;
use blast_arena::game::rng::Rng;
use blast_arena::game::{World, test_link};
use clap::Parser;

/// Counts every heap allocation made by the process.
struct Counting;

static ALLOCS: AtomicU64 = AtomicU64::new(0);
static ALLOC_BYTES: AtomicU64 = AtomicU64::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCS.fetch_add(1, Relaxed);
        ALLOC_BYTES.fetch_add(layout.size() as u64, Relaxed);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCS.fetch_add(1, Relaxed);
        ALLOC_BYTES.fetch_add(new_size as u64, Relaxed);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// Benchmark the Blast Arena simulation tick.
#[derive(Parser)]
#[command(about)]
struct Args {
    /// Server-side AI bots.
    #[arg(long, default_value_t = 200)]
    bots: usize,
    /// Simulated network clients (snapshots encoded and drained each tick).
    #[arg(long, default_value_t = 150)]
    clients: usize,
    /// Ticks to measure after warm-up.
    #[arg(long, default_value_t = 2000)]
    ticks: u32,
    /// Warm-up ticks (buffers reach their steady-state size).
    #[arg(long, default_value_t = 400)]
    warmup: u32,
    #[arg(long, default_value_t = 101)]
    map_size: i32,
}

fn main() {
    let args = Args::parse();
    let size = args.map_size.max(15) | 1;
    let mut rng = Rng::new(42);
    let map = Map::generate(size, size, 0.45, &mut rng);
    let mut world = World::with_map(map, rng, args.bots + args.clients + 8);
    world.set_target_bots(args.bots);

    let mut clients = Vec::new();
    let mut joined = 0;

    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };

    let mut times = Vec::with_capacity(args.ticks as usize);
    let mut allocs = Vec::with_capacity(args.ticks as usize);
    let (mut total_bytes, mut snapshot_bytes) = (0u64, 0u64);
    for t in 0..args.warmup + args.ticks {
        // Clients arrive a few per tick during warm-up, like real players.
        for _ in 0..4 {
            if joined < args.clients {
                let (link, rx) = test_link();
                let (input, snapshot) = (link.input.clone(), link.snapshot.clone());
                world.join(blast_arena::game::plain_join(&format!("client-{joined}")), link).expect("room for every client");
                input.set_view(20, 13);
                clients.push((input, snapshot, rx));
                joined += 1;
            }
        }
        // Simulated humans: change direction now and then, sometimes bomb.
        for (input, _, _) in &clients {
            let r = next();
            if r % 10 == 0 {
                input.set_dirs((r >> 8) as u8 % 5, (r >> 16) as u8 % 5, t as u16);
            }
            if r % 97 == 0 {
                input.press_bomb();
            }
        }

        let (a0, b0) = (ALLOCS.load(Relaxed), ALLOC_BYTES.load(Relaxed));
        let started = Instant::now();
        world.step();
        world.send_updates();
        world.drop_lagging_clients();
        let took = started.elapsed();
        let (a1, b1) = (ALLOCS.load(Relaxed), ALLOC_BYTES.load(Relaxed));

        // Drain like the socket writers would, and acknowledge the snapshot
        // like a browser does, so the next one can be a delta.
        let tick = world.tick as u32;
        for (input, snapshot, rx) in &mut clients {
            while rx.try_recv().is_ok() {}
            if let Some(s) = snapshot.take() {
                input.set_ack(tick);
                if t >= args.warmup {
                    snapshot_bytes += s.len() as u64;
                }
            }
        }
        if t >= args.warmup {
            times.push(took.as_nanos() as u64);
            allocs.push(a1 - a0);
            total_bytes += b1 - b0;
        }
    }

    let n = times.len() as f64;
    times.sort_unstable();
    let avg_ns = times.iter().sum::<u64>() as f64 / n;
    let p99 = times[(times.len() * 99 / 100).min(times.len() - 1)];
    let total_allocs: u64 = allocs.iter().sum();
    let zero_ticks = allocs.iter().filter(|&&a| a == 0).count();
    let s = world.stats;
    println!("players: {} ({} bots, {} clients), map {size}x{size}", world.players.len(), world.bots.len(), args.clients);
    println!("tick time:   avg {:.3} ms   p99 {:.3} ms   (budget 50 ms)", avg_ns / 1e6, p99 as f64 / 1e6);
    println!(
        "allocations: {:.2} per tick, {:.0} bytes per tick; {:.1}% of ticks allocated nothing",
        total_allocs as f64 / n,
        total_bytes as f64 / n,
        zero_ticks as f64 * 100.0 / n
    );
    println!("snapshots:   {:.0} bytes avg per client per tick", snapshot_bytes as f64 / n / args.clients.max(1) as f64);
    println!(
        "game:        {} deaths, {} crates, {} items, {} secret boxes",
        s.deaths, s.crates_destroyed, s.items_picked, s.mysteries_opened
    );
}
