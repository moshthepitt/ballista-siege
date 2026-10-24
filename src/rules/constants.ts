// Tuning knobs for docs/rules.md. The sim and the templates both read these, so a change here
// changes both. Changing a formula's shape is a rules change: edit docs/rules.md first.
export const C = {
  WAVES: 10n,
  WALLS_START: 40n,

  BALLISTA_DMG: 8n,
  FORGE_ST: 8n,
  WATCH_BONUS: 10n,
  CAULDRON_DMG: 1n,
  FORGE_AOE: 2n,
  PALISADE_SHIELD: 4n,
  QUARRY_GOLD: 8n,
  QUARRY_ADJ: 4n,

  SWARM_HP_BASE: 1n,
  SWARM_HP_STEP: 4n,
  SWARM_LEAK: 1n,
  BRUTE_HP_BASE: 4n,
  BRUTE_HP_PER_WAVE: 1n,
  BRUTE_LEAK: 3n,
  BRUTE_FROM_WAVE: 4n,
  HEAVY_BRUTE_FROM_WAVE: 7n,
  BRUTE_DIV: 4n,

  SWARM_BASE: 0n,
  SWARM_NUM: 1n,
  SWARM_DEN: 3n,
  SWARM_SPREAD: 2n,
  HEAVY_NUM: 1n,
  HEAVY_DEN: 3n,

  // Grid at the start of a run (nibble per cell, cell = lane * 4 + row).
  STARTING_GRID: 0x0001_0001_0001_0001n,
  // 16 part codes, one per nibble; offers index into it, so repeats raise a part's odds.
  OFFER_TABLE: 0x6655443322111654n,
} as const;

export const PART = {
  EMPTY: 0n,
  BALLISTA: 1n,
  CAULDRON: 2n,
  FORGE: 3n,
  WATCHTOWER: 4n,
  QUARRY: 5n,
  PALISADE: 6n,
} as const;

export const PART_NAMES = ['empty', 'Ballista', 'Cauldron', 'Forge', 'Watchtower', 'Quarry', 'Palisade'] as const;

export const LANES = 4n;
export const ROWS = 4n;
export const CELLS = 16n;
export const SECONDS_PER_DAY = 86400n;

// RNG constants from docs/rules.md (fixed, not tuning knobs).
export const RNG = {
  BASE: 0x9e3779b97f4a7c15n,
  DAY_MUL: 2654435761n,
  WAVE_MUL: 40503n,
  SALT_OFFERS: 0n,
  SALT_ENEMIES: 1n,
} as const;
