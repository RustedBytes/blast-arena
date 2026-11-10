//! Tuning of the six ability power-ups (builder, gas bomb, clone, sticky
//! bomb, portal pair, dash), loaded from JSON so balance changes need no
//! code change. `config/abilities.json` holds the defaults and is embedded
//! in the binary; `--abilities <file>` (or `ABILITIES_CONFIG`) replaces it.
//!
//! Every field may be left out (the default is used). Durations are given
//! in milliseconds and converted to simulation ticks once, at load time,
//! with a single rule: round half up, and never below one tick for a
//! duration that must be positive (see [`ms_to_ticks`]).

use serde::Deserialize;

use super::TICK_RATE;
use super::player::{MAX_GADGET_CHARGES, MAX_RANGE};

/// The defaults, as shipped.
pub const DEFAULT_JSON: &str = include_str!("../../config/abilities.json");
/// Schema version this server understands.
pub const CONFIG_VERSION: u32 = 1;

/// Milliseconds to ticks: round half up. `positive` durations never round
/// down to zero (a 10 ms timer still lasts one tick).
#[must_use]
pub fn ms_to_ticks(ms: u32, positive: bool) -> u64 {
    let ticks = (u64::from(ms) * u64::from(TICK_RATE) + 500) / 1000;
    if positive { ticks.max(1) } else { ticks }
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct BuilderCfg {
    pub enabled: bool,
    pub charges: u8,
    pub cooldown_ms: u32,
    pub wall_duration_ms: u32,
    pub wall_health: u8,
    pub placement_range: u8,
    pub max_active_walls: u8,
}

impl Default for BuilderCfg {
    fn default() -> Self {
        BuilderCfg { enabled: true, charges: 2, cooldown_ms: 8000, wall_duration_ms: 6000, wall_health: 1, placement_range: 1, max_active_walls: 2 }
    }
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct GasCfg {
    pub enabled: bool,
    pub charges: u8,
    pub fuse_ms: u32,
    pub cloud_duration_ms: u32,
    pub radius: u8,
    /// At most this many extra cells of radius from the owner's range
    /// power-ups (0: the radius is fixed).
    pub range_bonus: u8,
    pub movement_multiplier: f32,
    pub slow_after_exit_ms: u32,
    pub max_active_clouds: u8,
    /// Whether an ignited cloud burns teammates in team mode.
    pub friendly_fire: bool,
}

impl Default for GasCfg {
    fn default() -> Self {
        GasCfg {
            enabled: true,
            charges: 2,
            fuse_ms: 2500,
            cloud_duration_ms: 4000,
            radius: 2,
            range_bonus: 0,
            movement_multiplier: 0.7,
            slow_after_exit_ms: 500,
            max_active_clouds: 2,
            friendly_fire: false,
        }
    }
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct CloneCfg {
    pub enabled: bool,
    pub charges: u8,
    pub duration_ms: u32,
    pub playback_delay_ms: u32,
    pub cooldown_ms: u32,
    pub max_active: u8,
    /// How long a clone's decorative bomb stays on the ground.
    pub decoy_bomb_ms: u32,
}

impl Default for CloneCfg {
    fn default() -> Self {
        CloneCfg { enabled: true, charges: 1, duration_ms: 5000, playback_delay_ms: 2000, cooldown_ms: 18000, max_active: 1, decoy_bomb_ms: 1000 }
    }
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct StickyCfg {
    pub enabled: bool,
    pub charges: u8,
    pub fuse_ms: u32,
    pub throw_range: u8,
    pub detach_duration_ms: u32,
    pub max_attached_per_target: u8,
    /// Whether it sticks to teammates in team mode.
    pub friendly_fire: bool,
    /// Whether the remote power-up turns sticky bombs into remote ones.
    pub allow_remote: bool,
}

impl Default for StickyCfg {
    fn default() -> Self {
        StickyCfg {
            enabled: true,
            charges: 2,
            fuse_ms: 3000,
            throw_range: 2,
            detach_duration_ms: 800,
            max_attached_per_target: 1,
            friendly_fire: false,
            allow_remote: true,
        }
    }
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PortalCfg {
    pub enabled: bool,
    pub charges: u8,
    pub placement_range: u8,
    pub duration_ms: u32,
    pub placement_timeout_ms: u32,
    pub cooldown_ms: u32,
    pub teleport_cooldown_ms: u32,
    pub max_active_pairs: u8,
}

impl Default for PortalCfg {
    fn default() -> Self {
        PortalCfg {
            enabled: true,
            charges: 1,
            placement_range: 3,
            duration_ms: 12000,
            placement_timeout_ms: 5000,
            cooldown_ms: 20000,
            teleport_cooldown_ms: 750,
            max_active_pairs: 1,
        }
    }
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct DashCfg {
    pub enabled: bool,
    pub distance_cells: f32,
    pub duration_ms: u32,
    pub cooldown_ms: u32,
    pub charges: u8,
    pub invulnerable: bool,
}

impl Default for DashCfg {
    fn default() -> Self {
        DashCfg { enabled: true, distance_cells: 2.5, duration_ms: 200, cooldown_ms: 6000, charges: 1, invulnerable: false }
    }
}

#[derive(Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Abilities {
    pub builder: BuilderCfg,
    pub gas_bomb: GasCfg,
    pub clone: CloneCfg,
    pub sticky_bomb: StickyCfg,
    pub portal_pair: PortalCfg,
    pub dash: DashCfg,
}

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    abilities: Abilities,
}

fn default_version() -> u32 {
    CONFIG_VERSION
}

/// The configuration in simulation units, ready for the game loop.
#[derive(Clone, Debug, PartialEq)]
pub struct Tuning {
    pub raw: Abilities,
    pub builder_cooldown: u64,
    pub wall_ticks: u64,
    pub gas_fuse: u64,
    pub gas_ticks: u64,
    pub gas_linger: u64,
    pub clone_ticks: u64,
    pub clone_delay: u64,
    pub clone_cooldown: u64,
    pub decoy_ticks: u64,
    pub sticky_fuse: u64,
    pub detach_ticks: u64,
    pub portal_ticks: u64,
    pub portal_timeout: u64,
    pub portal_cooldown: u64,
    pub teleport_cooldown: u64,
    pub dash_ticks: u64,
    pub dash_cooldown: u64,
    /// Cells a dash covers per tick.
    pub dash_step: f32,
}

impl Default for Tuning {
    fn default() -> Self {
        Tuning::parse(DEFAULT_JSON).expect("the shipped abilities config is valid")
    }
}

impl Tuning {
    /// Whether an item may appear in play: everything except abilities
    /// switched off in the configuration.
    #[must_use]
    pub fn item_enabled(&self, item: super::items::Item) -> bool {
        use super::items::Item;
        let a = &self.raw;
        match item {
            Item::Builder => a.builder.enabled,
            Item::GasBomb => a.gas_bomb.enabled,
            Item::Clone => a.clone.enabled,
            Item::StickyBomb => a.sticky_bomb.enabled,
            Item::PortalPair => a.portal_pair.enabled,
            Item::Dash => a.dash.enabled,
            _ => true,
        }
    }

    /// Parses and validates a configuration file's contents.
    ///
    /// # Errors
    /// Malformed JSON, unknown fields, an unsupported version, or values
    /// out of range (see [`Tuning::from_abilities`]).
    pub fn parse(json: &str) -> Result<Tuning, String> {
        let file: File = serde_json::from_str(json).map_err(|e| format!("abilities config: {e}"))?;
        if file.version != CONFIG_VERSION {
            return Err(format!("abilities config: version {} is not supported (expected {CONFIG_VERSION})", file.version));
        }
        Self::from_abilities(file.abilities)
    }

    /// Reads a configuration file.
    ///
    /// # Errors
    /// The file can't be read, or [`Tuning::parse`] rejects it.
    pub fn load(path: &str) -> Result<Tuning, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("abilities config {path}: {e}"))?;
        Self::parse(&text)
    }

    /// Validates the values and converts durations to ticks.
    ///
    /// # Errors
    /// Describes the first value out of range.
    pub fn from_abilities(a: Abilities) -> Result<Tuning, String> {
        let range = |name: &str, v: u8, lo: u8, hi: u8| {
            if (lo..=hi).contains(&v) { Ok(()) } else { Err(format!("abilities config: {name} = {v} must be within {lo}..={hi}")) }
        };
        let positive = |name: &str, v: u32| if v > 0 { Ok(()) } else { Err(format!("abilities config: {name} must be positive")) };
        let charges = MAX_GADGET_CHARGES;

        range("builder.charges", a.builder.charges, 1, charges)?;
        range("builder.wallHealth", a.builder.wall_health, 1, 9)?;
        range("builder.placementRange", a.builder.placement_range, 1, 3)?;
        range("builder.maxActiveWalls", a.builder.max_active_walls, 1, 16)?;
        positive("builder.wallDurationMs", a.builder.wall_duration_ms)?;

        range("gas_bomb.charges", a.gas_bomb.charges, 1, charges)?;
        range("gas_bomb.radius", a.gas_bomb.radius, 1, MAX_RANGE)?;
        range("gas_bomb.rangeBonus", a.gas_bomb.range_bonus, 0, MAX_RANGE - a.gas_bomb.radius.min(MAX_RANGE))?;
        range("gas_bomb.maxActiveClouds", a.gas_bomb.max_active_clouds, 1, 16)?;
        positive("gas_bomb.fuseMs", a.gas_bomb.fuse_ms)?;
        positive("gas_bomb.cloudDurationMs", a.gas_bomb.cloud_duration_ms)?;
        let m = a.gas_bomb.movement_multiplier;
        if !(m > 0.0 && m <= 1.0) {
            return Err(format!("abilities config: gas_bomb.movementMultiplier = {m} must be within (0, 1]"));
        }

        range("clone.charges", a.clone.charges, 1, charges)?;
        range("clone.maxActive", a.clone.max_active, 1, 4)?;
        positive("clone.durationMs", a.clone.duration_ms)?;
        positive("clone.playbackDelayMs", a.clone.playback_delay_ms)?;
        positive("clone.decoyBombMs", a.clone.decoy_bomb_ms)?;
        // The movement history covers HISTORY_TICKS; the clone replays from it.
        if ms_to_ticks(a.clone.playback_delay_ms, true) >= super::clone::HISTORY_TICKS as u64 {
            return Err(format!(
                "abilities config: clone.playbackDelayMs must be shorter than the {} ms of recorded movement",
                super::clone::HISTORY_TICKS as u32 * 1000 / TICK_RATE
            ));
        }

        range("sticky_bomb.charges", a.sticky_bomb.charges, 1, charges)?;
        range("sticky_bomb.throwRange", a.sticky_bomb.throw_range, 0, 4)?;
        range("sticky_bomb.maxAttachedPerTarget", a.sticky_bomb.max_attached_per_target, 1, 4)?;
        positive("sticky_bomb.fuseMs", a.sticky_bomb.fuse_ms)?;
        positive("sticky_bomb.detachDurationMs", a.sticky_bomb.detach_duration_ms)?;

        range("portal_pair.charges", a.portal_pair.charges, 1, charges)?;
        range("portal_pair.placementRange", a.portal_pair.placement_range, 1, 8)?;
        range("portal_pair.maxActivePairs", a.portal_pair.max_active_pairs, 1, 4)?;
        positive("portal_pair.durationMs", a.portal_pair.duration_ms)?;
        positive("portal_pair.placementTimeoutMs", a.portal_pair.placement_timeout_ms)?;
        // A zero lock would let an object bounce A -> B -> A every tick.
        positive("portal_pair.teleportCooldownMs", a.portal_pair.teleport_cooldown_ms)?;

        range("dash.charges", a.dash.charges, 1, charges)?;
        positive("dash.durationMs", a.dash.duration_ms)?;
        let d = a.dash.distance_cells;
        if !(d > 0.0 && d <= 8.0) {
            return Err(format!("abilities config: dash.distanceCells = {d} must be within (0, 8]"));
        }

        let dash_ticks = ms_to_ticks(a.dash.duration_ms, true);
        Ok(Tuning {
            builder_cooldown: ms_to_ticks(a.builder.cooldown_ms, false),
            wall_ticks: ms_to_ticks(a.builder.wall_duration_ms, true),
            gas_fuse: ms_to_ticks(a.gas_bomb.fuse_ms, true),
            gas_ticks: ms_to_ticks(a.gas_bomb.cloud_duration_ms, true),
            gas_linger: ms_to_ticks(a.gas_bomb.slow_after_exit_ms, false),
            clone_ticks: ms_to_ticks(a.clone.duration_ms, true),
            clone_delay: ms_to_ticks(a.clone.playback_delay_ms, true),
            clone_cooldown: ms_to_ticks(a.clone.cooldown_ms, false),
            decoy_ticks: ms_to_ticks(a.clone.decoy_bomb_ms, true),
            sticky_fuse: ms_to_ticks(a.sticky_bomb.fuse_ms, true),
            detach_ticks: ms_to_ticks(a.sticky_bomb.detach_duration_ms, true),
            portal_ticks: ms_to_ticks(a.portal_pair.duration_ms, true),
            portal_timeout: ms_to_ticks(a.portal_pair.placement_timeout_ms, true),
            portal_cooldown: ms_to_ticks(a.portal_pair.cooldown_ms, false),
            teleport_cooldown: ms_to_ticks(a.portal_pair.teleport_cooldown_ms, true),
            dash_ticks,
            dash_cooldown: ms_to_ticks(a.dash.cooldown_ms, false),
            dash_step: d / dash_ticks as f32,
            raw: a,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shipped_defaults_match_the_spec() {
        let t = Tuning::default();
        assert_eq!(t.raw, Abilities::default(), "the JSON file and the Rust defaults agree");
        assert_eq!((t.builder_cooldown, t.wall_ticks), (160, 120));
        assert_eq!((t.gas_fuse, t.gas_ticks, t.gas_linger), (50, 80, 10));
        assert_eq!((t.clone_ticks, t.clone_delay, t.clone_cooldown, t.decoy_ticks), (100, 40, 360, 20));
        assert_eq!((t.sticky_fuse, t.detach_ticks), (60, 16));
        assert_eq!((t.portal_ticks, t.portal_timeout, t.portal_cooldown, t.teleport_cooldown), (240, 100, 400, 15));
        assert_eq!((t.dash_ticks, t.dash_cooldown), (4, 120));
        assert!((t.dash_step - 0.625).abs() < 1e-6);
    }

    #[test]
    fn rounding_rule_is_half_up_and_positive_never_zero() {
        assert_eq!(ms_to_ticks(25, false), 1, "0.5 tick rounds up");
        assert_eq!(ms_to_ticks(24, false), 0);
        assert_eq!(ms_to_ticks(1, true), 1);
        assert_eq!(ms_to_ticks(0, false), 0);
        assert_eq!(ms_to_ticks(750, true), 15);
    }

    #[test]
    fn partial_files_fall_back_to_defaults() {
        let t = Tuning::parse(r#"{"abilities": {"dash": {"distanceCells": 3.0}}}"#).unwrap();
        assert!((t.raw.dash.distance_cells - 3.0).abs() < 1e-6);
        assert_eq!(t.raw.builder, BuilderCfg::default());
        assert_eq!(Tuning::parse("{}").unwrap(), Tuning::default());
    }

    #[test]
    fn invalid_values_are_rejected() {
        let bad = [
            r#"{"abilities": {"gas_bomb": {"movementMultiplier": 0}}}"#,
            r#"{"abilities": {"gas_bomb": {"movementMultiplier": 1.5}}}"#,
            r#"{"abilities": {"builder": {"wallDurationMs": 0}}}"#,
            r#"{"abilities": {"portal_pair": {"teleportCooldownMs": 0}}}"#,
            r#"{"abilities": {"gas_bomb": {"radius": 30}}}"#,
            r#"{"abilities": {"dash": {"distanceCells": -1}}}"#,
            r#"{"abilities": {"clone": {"playbackDelayMs": 9000}}}"#,
            r#"{"abilities": {"dash": {"speed": 1}}}"#,
            r#"{"version": 2}"#,
            "not json",
        ];
        for json in bad {
            assert!(Tuning::parse(json).is_err(), "accepted: {json}");
        }
    }
}
