// Colour ramps for the tiles (dark to light, hue-shifting) and the block
// geometry shared by the generators.

/** Rows 0..TOP-1 are a block's top face; rows TOP..N-2 its front face. */
export const TOP = 11;

/** Colour of a block face pixel. */
export type Shade = (x: number, y: number) => string;

// ------------------------------------------------------------------ palette
// Each ramp runs dark to light, shifting hue along the way.

export const GRASS = ['#1b3a30', '#24523a', '#2e6a3c', '#3c8240', '#539b45', '#78b74e', '#a9d468'];
export const SNOW = ['#56688f', '#7489b2', '#9db1d3', '#c3d3e8', '#e3ecf6', '#ffffff'];
export const SAND = ['#6e4128', '#93603a', '#b7824c', '#d2a160', '#e6bf7c', '#f5dca2'];
export const ASH = ['#120e17', '#1d1621', '#2a1f2b', '#382934', '#4a3842', '#5e4a50'];
export const STONE = ['#191a28', '#272b3e', '#383f58', '#4d5772', '#67748f', '#8796ae', '#aebbcd', '#d8e0ea'];
export const MOSS = ['#203a26', '#2f5530', '#46753a', '#679a45', '#8fbd57'];
export const SANDSTONE = ['#3d2220', '#5e3428', '#844c33', '#a86843', '#c78a57', '#e0ac70', '#f2cf94'];
// Desert walls are pale limestone (cool shadows, cream tops), so they never
// read as the warm wooden crates around them.
export const LIMESTONE = ['#2a2433', '#4a4257', '#6e6577', '#968b94', '#bdb0a8', '#dccfbf', '#f3ead8'];
// Dungeon flagstones: worn, warm grey stone, quieter and lighter than the walls.
export const FLAGSTONE = ['#1e1a1a', '#2e2928', '#3d3734', '#4b4540', '#59524b', '#675f56', '#776d62'];
// Dungeon brick: cold, dark and a little damp.
export const CRYPT = ['#0c0b12', '#16141f', '#211e2c', '#2d2939', '#3a3547', '#4a4458', '#5d566c', '#7a7189'];
export const OBSIDIAN = ['#08060c', '#130e1b', '#1f1729', '#2e2240', '#45345e', '#5d4b7d', '#7a68a3'];
export const WOOD = ['#2e1712', '#4f2a1b', '#743f23', '#98582c', '#b8733a', '#d4974f', '#ecbd72', '#f8dea0'];
export const ICE = ['#1f4c82', '#2f6fae', '#4f98d4', '#7fc0ea', '#b2e2f8', '#e2f7ff', '#ffffff'];
export const RUBBER = ['#0e0f14', '#17191f', '#22252d', '#2e323c', '#3d4250'];
export const PORTAL = ['#1a0d33', '#2f1763', '#4c2a99', '#7448d6', '#a07cff', '#cdb8ff', '#f2ecff'];
export const FLOWERS = [['#fff7e8', '#ffd75e'], ['#ff9ec4', '#fff1a8'], ['#9fd2ff', '#ffffff']];
export const HAZARD = ['#f2c230', '#a8861f', '#26262e', '#15151b'];
export const RUNE = '#7ff6ff';
