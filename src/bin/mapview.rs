//! Map preview: prints generated arenas as text, with the style the dice
//! rolled and the generator's quality report, so layout changes can be
//! judged without starting a server.
//!
//! Usage: cargo run --release --bin mapview -- [--size 41] [--seed 1] [--count 3] [--open]
//!
//! Legend: `#` wall, `+` crate, `%` armored crate, `~` ice, `^>v<` conveyor,
//! `@` teleporter, `.` floor.

use blast_arena::game::map::{Map, Tile};
use blast_arena::game::rng::{Rng, derive_seed};
use clap::Parser;

#[derive(Parser)]
struct Args {
    /// Width and height of the map.
    #[arg(long, default_value_t = 41)]
    size: i32,
    /// Base seed; map `k` uses the `k`-th seed derived from it.
    #[arg(long, default_value_t = 1)]
    seed: u64,
    /// How many maps to print.
    #[arg(long, default_value_t = 3)]
    count: u64,
    /// Generate battle royale (open) maps.
    #[arg(long)]
    open: bool,
    /// Print only the summary lines, not the maps.
    #[arg(long)]
    quiet: bool,
}

fn glyph(t: Tile) -> char {
    match t {
        Tile::Floor => '.',
        Tile::Wall | Tile::Built => '#',
        Tile::Crate => '+',
        Tile::Armored => '%',
        Tile::Ice => '~',
        Tile::ConveyorUp => '^',
        Tile::ConveyorRight => '>',
        Tile::ConveyorDown => 'v',
        Tile::ConveyorLeft => '<',
        Tile::Teleport => '@',
    }
}

fn main() {
    let args = Args::parse();
    for k in 0..args.count {
        let seed = derive_seed(args.seed, k);
        let mut rng = Rng::new(seed);
        let map = if args.open { Map::generate_open(args.size, args.size, &mut rng) } else { Map::generate(args.size, args.size, 0.45, &mut rng) };
        let s = &map.style;
        println!(
            "seed {seed}: {:?} {:?}, crates {:.2}, teleports {}, regions {:?}",
            s.pillars,
            s.symmetry,
            s.crate_density,
            map.teleports.len(),
            map.biomes.iter().map(|b| b.biome).collect::<Vec<_>>()
        );
        println!("  {}", map.quality());
        if !args.quiet {
            for y in 0..map.h {
                let row: String = (0..map.w).map(|x| glyph(map.get(x, y))).collect();
                println!("  {row}");
            }
            println!();
        }
    }
}
