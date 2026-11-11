//! Simulation benchmark: runs the world in-process with server bots and
//! simulated clients (whose snapshots are really encoded and then drained),
//! and reports time and heap allocations per tick, the worst ticks and
//! where their time went.
//!
//! Usage: cargo run --release --bin simbench -- [--bots 200] [--clients 150] [--ticks 2000]
//!
//! Crowded arenas:
//!   Horde with players: --map-size 321 --bots 1000 --clients 50
//!   a full Main arena:  --map-size 81 --bots 10 --clients 246
//! `--round-secs 30` puts round ends into the run; `--churn 20` makes a
//! client leave and a new one join every 20 ticks (timed inside the tick,
//! as the server does).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use blast_arena::game::map::Map;
use blast_arena::game::rng::Rng;
use blast_arena::game::{PHASES, TickProfile, World, test_link};
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
    /// Map and simulation seed.
    #[arg(long, default_value_t = 42)]
    seed: u64,
    /// Round length (0 keeps the default 300 s, which a run rarely reaches).
    #[arg(long, default_value_t = 0)]
    round_secs: u32,
    /// Every this many measured ticks a client leaves and a new one joins
    /// (0: never). The join is timed as part of the tick, like the server.
    #[arg(long, default_value_t = 0)]
    churn: u32,
    /// Worst ticks to break down by phase.
    #[arg(long, default_value_t = 8)]
    worst: usize,
}

/// CPU time used by this thread so far: unlike wall time it doesn't count
/// time the OS had the thread descheduled.
fn thread_cpu() -> Duration {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &raw mut ts) };
    Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}

/// Asks the OS to treat the benchmark thread as interactive. On macOS that
/// keeps it on the performance cores instead of the efficiency ones.
fn prefer_fast_cores() {
    #[cfg(target_os = "macos")]
    unsafe {
        libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_USER_INTERACTIVE, 0);
    }
}

struct Tick {
    total: Duration,
    cpu: Duration,
    join: Duration,
    phases: [Duration; PHASES.len()],
    n: u32,
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1e3
}

fn main() {
    let args = Args::parse();
    prefer_fast_cores();
    let size = args.map_size.max(15) | 1;
    let mut rng = Rng::new(args.seed);
    let map = Map::generate(size, size, 0.45, &mut rng);
    let mut world = World::with_map(map, rng, args.bots + args.clients + 8);
    world.set_target_bots(args.bots);
    if args.round_secs > 0 {
        world.set_round_secs(args.round_secs);
    }
    world.profile = Some(Box::<TickProfile>::default());

    let mut clients = Vec::new();
    let mut joined = 0;
    let mut seed = 0x9E37_79B9_7F4A_7C15u64 ^ args.seed;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let join = |world: &mut World, clients: &mut Vec<_>, joined: &mut usize| {
        let (link, rx) = test_link();
        let (input, snapshot) = (link.input.clone(), link.snapshot.clone());
        let id = world.join(blast_arena::game::plain_join(&format!("client-{joined}")), link).expect("room for every client");
        input.set_view(20, 13);
        clients.push((id, input, snapshot, rx));
        *joined += 1;
    };

    let mut ticks: Vec<Tick> = Vec::with_capacity(args.ticks as usize);
    let mut allocs = Vec::with_capacity(args.ticks as usize);
    let (mut total_bytes, mut snapshot_bytes) = (0u64, 0u64);
    let mut joins = Vec::new();
    for t in 0..args.warmup + args.ticks {
        let measured = t >= args.warmup;
        // Clients arrive a few per tick during warm-up, like real players.
        for _ in 0..4 {
            if clients.len() < args.clients {
                join(&mut world, &mut clients, &mut joined);
            }
        }
        // Simulated humans: one input per step (like the real client),
        // changing direction now and then, sometimes bombing.
        for (_, input, _, _) in &clients {
            let r = next();
            let (mut d, mut s, _, _) = input.dirs();
            if r % 10 == 0 {
                (d, s) = ((r >> 8) as u8 % 5, (r >> 16) as u8 % 5);
            }
            input.set_dirs(d, s, false, t as u16);
            if r % 97 == 0 {
                input.press_bomb();
            }
        }

        let (a0, b0) = (ALLOCS.load(Relaxed), ALLOC_BYTES.load(Relaxed));
        let started = Instant::now();
        let cpu0 = thread_cpu();
        // Like the server's tick: pending joins and leaves first.
        let mut join_time = Duration::ZERO;
        if measured && args.churn > 0 && t.is_multiple_of(args.churn) && !clients.is_empty() {
            let (id, ..) = clients.remove((next() % clients.len() as u64) as usize);
            world.leave(id);
            let j = Instant::now();
            join(&mut world, &mut clients, &mut joined);
            join_time = j.elapsed();
            joins.push(join_time);
        }
        world.step();
        world.send_updates_profiled();
        world.drop_lagging_clients();
        let took = started.elapsed();
        let cpu = thread_cpu().saturating_sub(cpu0);
        let (a1, b1) = (ALLOCS.load(Relaxed), ALLOC_BYTES.load(Relaxed));

        // Drain like the socket writers would, and acknowledge the snapshot
        // like a browser does, so the next one can be a delta.
        let tick = world.tick as u32;
        for (_, input, snapshot, rx) in &mut clients {
            while rx.try_recv().is_ok() {}
            if let Some(s) = snapshot.take() {
                input.set_ack(tick);
                if measured {
                    snapshot_bytes += s.len() as u64;
                }
            }
        }
        if measured {
            let phases = world.profile.as_ref().map_or([Duration::ZERO; PHASES.len()], |p| p.last);
            ticks.push(Tick { cpu, total: took, join: join_time, phases, n: tick });
            allocs.push(a1 - a0);
            total_bytes += b1 - b0;
        }
    }

    report(&args, &world, size, ticks, &allocs, total_bytes, snapshot_bytes, joins);
}

/// Prints the run's tick times, allocations and traffic, where the time
/// went phase by phase, and the worst ticks broken down.
#[allow(clippy::too_many_arguments, reason = "the run's results, reported once")]
fn report(args: &Args, world: &World, size: i32, mut ticks: Vec<Tick>, allocs: &[u64], total_bytes: u64, snapshot_bytes: u64, mut joins: Vec<Duration>) {
    let n = ticks.len() as f64;
    let mut sorted: Vec<Duration> = ticks.iter().map(|t| t.total).collect();
    sorted.sort_unstable();
    let pct = |p: f64| ms(sorted[((sorted.len() as f64 * p) as usize).min(sorted.len() - 1)]);
    let avg = ms(sorted.iter().sum::<Duration>()) / n;
    let total_allocs: u64 = allocs.iter().sum();
    let zero_ticks = allocs.iter().filter(|&&a| a == 0).count();
    let s = world.stats;
    println!("players: {} ({} bots, {} clients), map {size}x{size}", world.players.len(), world.bots.len(), args.clients);
    println!(
        "tick time:   avg {avg:.3} ms   p50 {:.3}   p99 {:.3}   p99.9 {:.3}   max {:.3} ms   (budget 50 ms)",
        pct(0.5),
        pct(0.99),
        pct(0.999),
        ms(*sorted.last().unwrap())
    );
    let mut cpu: Vec<Duration> = ticks.iter().map(|t| t.cpu).collect();
    cpu.sort_unstable();
    let cpct = |p: f64| ms(cpu[((cpu.len() as f64 * p) as usize).min(cpu.len() - 1)]);
    println!(
        "tick CPU:    avg {:.3} ms   p50 {:.3}   p99 {:.3}   p99.9 {:.3}   max {:.3} ms   (thread CPU time: without OS preemption)",
        ms(cpu.iter().sum::<Duration>()) / n,
        cpct(0.5),
        cpct(0.99),
        cpct(0.999),
        ms(*cpu.last().unwrap())
    );
    println!(
        "allocations: {:.2} per tick, {:.0} bytes per tick; {:.1}% of ticks allocated nothing",
        total_allocs as f64 / n,
        total_bytes as f64 / n,
        zero_ticks as f64 * 100.0 / n
    );
    println!("snapshots:   {:.0} bytes avg per client per tick", snapshot_bytes as f64 / n / args.clients.max(1) as f64);
    if !joins.is_empty() {
        joins.sort_unstable();
        println!("joins:       {} timed, avg {:.3} ms, max {:.3} ms", joins.len(), ms(joins.iter().sum::<Duration>()) / joins.len() as f64, ms(*joins.last().unwrap()));
    }
    println!(
        "game:        {} deaths, {} crates, {} items, {} secret boxes, {} rounds",
        s.deaths, s.crates_destroyed, s.items_picked, s.mysteries_opened, s.rounds
    );
    println!(
        "abilities:   {} dashes, {} clones, {} portal pairs, {} teleports, {} sticky hits, {} gas ignitions, {} events",
        s.dashes, s.clones, s.portal_pairs, s.teleports, s.sticky_attached, s.gas_ignitions, s.ability_events
    );

    // Where the time goes: each phase's mean and worst over all ticks.
    println!("\nphase                                         mean ms    max ms");
    for (i, name) in PHASES.iter().enumerate() {
        let mean = ticks.iter().map(|t| ms(t.phases[i])).sum::<f64>() / n;
        let max = ticks.iter().map(|t| ms(t.phases[i])).fold(0.0, f64::max);
        println!("  {name:<42} {mean:>8.3}  {max:>8.3}");
    }
    println!("  {:<42} {:>8.3}  {:>8.3}", "join (churn)", ticks.iter().map(|t| ms(t.join)).sum::<f64>() / n, ticks.iter().map(|t| ms(t.join)).fold(0.0, f64::max));

    // The worst ticks (by CPU time: the work itself), and their three
    // biggest phases.
    ticks.sort_by_key(|t| std::cmp::Reverse(t.cpu));
    println!("\nworst ticks by CPU time:");
    for t in ticks.iter().take(args.worst) {
        let mut parts: Vec<(f64, &str)> = t.phases.iter().zip(PHASES).map(|(d, n)| (ms(*d), n)).collect();
        parts.push((ms(t.join), "join"));
        parts.sort_by(|a, b| b.0.total_cmp(&a.0));
        let top: Vec<String> = parts.iter().take(3).filter(|p| p.0 >= 0.05).map(|(d, n)| format!("{n} {d:.2}")).collect();
        println!("  tick {:>6}: {:>7.3} ms (CPU {:>7.3}) = {}", t.n, ms(t.total), ms(t.cpu), top.join(", "));
    }
}
