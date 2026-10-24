import { C, LIMITS as L, PART as P, PRICE } from '../src/v1/constants.js';
import { forecast, upgradeCost, type RunState } from '../src/v1/sim.js';

export const glossary = {
  Damage: 'HP lost: health removed from each unit, times the units hit. Armour and overkill reduce HP lost. The event log shows damage dealt.',
  Wall: `You start with ${C.START_WALLS} walls. Enemies that reach the wall knock some down, and walls never come back. Lose all ${C.START_WALLS} and the run ends.`,
  Wave: `${L.WAVES === 10 ? 'Ten' : L.WAVES} waves. Each wave you build, then watch the fight. Survive through wave ${L.WAVES} to win.`,
  Lane: `${L.LANES === 4 ? 'Four' : L.LANES} lanes. Enemies walk straight down their lane toward the wall.`,
  Depth: `D1 is next to your wall. D${L.DEPTHS} is nearest the entrance, where enemies come in.`,
  Tick: `A fight lasts ${L.TICKS} ticks. Each tick your parts fire, enemies bite, then enemies step one cell closer.`,
  Action: `Buy, upgrade, sell, reroll and overclock each use one action. You get ${L.ACTIONS} per wave. Undo is free.`,
  Reroll: `Swap all ${L.SHOP_SLOTS === 4 ? 'four' : L.SHOP_SLOTS} offers for new ones. The first reroll in a wave costs 1 gold, the next 2, then 3. Uses an action.`,
  Trample: "An enemy that steps onto one of your parts switches it off until the next wave. A standing Palisade blocks entry until its HP reaches 0.",
  Leak: `Enemies that reach the wall knock down walls: Swarm ${C.SWARM_LEAK} each, Brute ${C.BRUTE_LEAK} each, a boss ${C.BOSS_LEAK_BASE + 1n} to ${C.BOSS_LEAK}.`,
  Storm: `After tick ${L.TICKS}, every enemy still alive charges the wall, even past Palisades. Only kills stop it.`,
  Tier: `Parts go up to tier ${L.TIERS}. Weapon damage and Palisade HP multiply by the tier.`,
  Overclock: `Tier-${L.TIERS} weapons and Palisades only. For ${C.OVERCLOCK_COST} gold and an action: +50% damage, or +${C.OVERCLOCK_HP} HP on a Palisade, for the next fight.`,
} as const;
export type GlossaryTerm = keyof typeof glossary;
export const shopHelp = `${L.SHOP_SLOTS === 4 ? 'Four' : L.SHOP_SLOTS} offers each wave. The first is always a weapon. Each offer can be bought once. The seed decides every offer, so the same seed shows the same parts.`;
export const openingShop = 'Your first shop always has both weapons and a Palisade.';
export const receiptHelp = `After each wave you get ${C.INCOME} gold, ${C.CLEAR_GOLD} more for every nonempty lane where you killed everything, your Quarry income, and 1 per ${C.SALVAGE_KILLS} kills. Brutes pay ${C.BRUTE_BOUNTY} gold when they die and bosses pay ${C.BOSS_BOUNTY}.`;
export const scoreHelp = `Score: ${C.SCORE_WAVE} per wave survived, ${C.SCORE_WALL} per wall left, ${C.SCORE_KILL} per kill.`;
export const incomingHelp = "Groups come in one at a time. 'Tick 2' means this group arrives at the end of tick 2. They walk one cell per tick unless a Palisade stops them.";
export const combos = [
  'Palisade in front, weapons behind: every tick it holds is another round of shots.',
  'A Forge between two weapons boosts both.',
  "Weapons in one row share a single Watchtower's bonus.",
  'Upgrade a boosted weapon before buying another. Its tier multiplies the Forge and Watchtower bonus too.',
  'A Cauldron behind a Palisade shreds Swarm. Bring a Ballista or a Forge for Brutes.',
  'Weapons at D1 and D2 last longer. Parts nearer the entrance get trampled sooner.',
  'A boss that survives with less HP takes fewer walls.',
] as const;
export const synergy = (p: bigint) => p === P.PALISADE ? combos[0] : p === P.FORGE ? combos[1] : p === P.WATCHTOWER ? combos[2] : p === P.CAULDRON ? combos[4] : '';
export const enemyLessons = {
  swarm: { name: 'Swarm', copy: `Groups of weak units, ${C.SWARM_HP} HP early and a little more later. Bite ${C.SWARM_BITE}, leak ${C.SWARM_LEAK} wall each. Splash handles them.` },
  brute: { name: 'Brute', copy: `One or two tough units, ${C.BRUTE_HP} HP and up. Armour blocks ${C.BRUTE_SPLASH_ARMOR} splash damage per tick. Bite ${C.BRUTE_BITE}, leak ${C.BRUTE_LEAK} walls each, pays ${C.BRUTE_BOUNTY} gold. Ballistas handle them.` },
  gatebreaker: { name: 'Gatebreaker (wave 5)', copy: `${C.BOSS_5_HP} HP. Bites ${C.GATEBREAKER_BITE_EVEN} on even ticks, ${C.GATEBREAKER_BITE_ODD} on odd. Leaks ${C.BOSS_LEAK_BASE + 1n} to ${C.BOSS_LEAK} walls depending on HP left, so every hit counts. Pays ${C.BOSS_BOUNTY} gold.` },
  'last-siege': { name: 'Last Siege (wave 10)', copy: `${C.BOSS_10_HP} HP. Halves Ballista damage on even ticks; splash hits it in full. Leaks ${C.BOSS_LEAK_BASE + 1n} to ${C.BOSS_LEAK} walls. Pays ${C.BOSS_BOUNTY} gold.` },
} as const;
export type EnemyLesson = keyof typeof enemyLessons;
export interface PartLesson { job: string; numbers: string; range: string; works: string; weak: string; tiers: string[]; unit: string; costs: bigint[]; example?: string }
export function partLesson(part: bigint): PartLesson {
  const common = { costs: [PRICE[Number(part)], upgradeCost(part, 1n), upgradeCost(part, 2n)] };
  const tiers = (base: bigint) => [1n, 2n, 3n].map(t => String(base * t));
  if (part === P.BALLISTA) return { ...common,
    job: 'Shoots the enemy group closest to your wall, every tick.',
    numbers: `${C.BALLISTA_DAMAGE} at tier 1, ${C.BALLISTA_DAMAGE * 2n} at tier 2, ${C.BALLISTA_DAMAGE * 3n} at tier 3. Extra damage carries into the next unit of the same group.`,
    range: `Its own cell and the ${C.BALLISTA_RANGE} cells toward the entrance.`,
    works: `A Forge beside it adds ${C.FORGE_BALLISTA} per Forge tier. A Watchtower in its row adds the tower's tier and ${C.WATCH_RANGE} cell of range each way. A Palisade 1 or 2 cells ahead keeps enemies in its range for more shots. The Ballista's tier multiplies every bonus.`,
    weak: 'Many separate groups, since it hits one group at a time. Last Siege halves its damage on even ticks.', tiers: tiers(C.BALLISTA_DAMAGE), unit: 'Damage / tick' };
  if (part === P.CAULDRON) return { ...common,
    job: 'Splashes every enemy in range, every tick.',
    numbers: `${C.CAULDRON_DAMAGE} to every unit at tier 1, ${C.CAULDRON_DAMAGE * 2n} at tier 2, ${C.CAULDRON_DAMAGE * 3n} at tier 3.`,
    range: `Its own cell and the ${C.CAULDRON_RANGE} cells toward the entrance.`,
    works: `A Forge beside it adds ${C.FORGE_CAULDRON} per Forge tier. A Watchtower in its row adds damage and range. A Palisade ahead keeps a crowd inside the splash.`,
    weak: `Brutes. Their armour blocks ${C.BRUTE_SPLASH_ARMOR} splash damage per tick, so a tier-1 Cauldron can't hurt them. Upgrade it or add a Forge.`, tiers: tiers(C.CAULDRON_DAMAGE), unit: 'Damage / unit / tick' };
  if (part === P.PALISADE) return { ...common,
    job: "Enemies can't enter its cell. They stop in the cell above it and bite it.",
    numbers: `${C.PALISADE_HP} at tier 1, ${C.PALISADE_HP * 2n} at tier 2, ${C.PALISADE_HP * 3n} at tier 3. Back to full every wave.`,
    range: 'Stops enemies in the cell above it.', works: 'Weapons behind it that reach the cell above it.',
    weak: `After tick ${L.TICKS}, everything still alive storms past it.`, tiers: tiers(C.PALISADE_HP), unit: 'HP',
    example: `Bites per tick: Swarm ${C.SWARM_BITE} each, Brute ${C.BRUTE_BITE} each, Last Siege ${C.BOSS_BITE}. Gatebreaker bites ${C.GATEBREAKER_BITE_EVEN} on even ticks and rests on odd ticks.` };
  if (part === P.FORGE) return { ...common,
    job: 'Makes the weapons touching it stronger. Alone it does nothing.',
    numbers: `Per Forge tier: +${C.FORGE_BALLISTA} Ballista damage, +${C.FORGE_CAULDRON} Cauldron damage, before the weapon's tier multiplies it. Several Forges add up.`,
    range: 'The cell above, below, left or right.', works: combos[1], weak: 'Enemies can trample it and remove its bonuses.',
    tiers: [1n, 2n, 3n].map(t => `+${C.FORGE_BALLISTA * t} / +${C.FORGE_CAULDRON * t}`), unit: 'Ballista / Cauldron bonus',
    example: `Tier-2 Ballista beside a tier-1 Forge: (${C.BALLISTA_DAMAGE} + ${C.FORGE_BALLISTA}) × 2 = ${(C.BALLISTA_DAMAGE + C.FORGE_BALLISTA) * 2n} damage.` };
  if (part === P.WATCHTOWER) return { ...common,
    job: 'Boosts every weapon at the same depth across the lanes.',
    numbers: `+${C.WATCH_DAMAGE} damage per tower tier, before the weapon's tier multiplies it, and ${C.WATCH_RANGE} more cell of range each way. Only the strongest tower in a row counts.`,
    range: 'Every lane at its depth.', works: combos[2], weak: 'Enemies can trample it and remove its row bonus.', tiers: tiers(C.WATCH_DAMAGE).map(n => `+${n}`), unit: 'Row damage bonus' };
  return { ...common, job: 'Earns gold after each wave.',
    numbers: `${C.QUARRY_GOLD} per tier, ${C.QUARRY_ADJACENT} more for each Quarry touching it, and ${C.QUARRY_DEEP} more at D3 or D4. A trampled Quarry earns nothing that wave.`,
    range: 'Touching Quarries add income. D3 or D4 adds gold.', works: 'Quarries touching it and weapons that keep enemies away.', weak: 'Enemies can switch it off before payday.', tiers: tiers(C.QUARRY_GOLD), unit: 'Base gold / wave' };
}

/** HP is taken from the actual scout window, including the heavy-lane variant. */
export function scoutEnemyCopy(state: RunState, key: EnemyLesson): string {
  const groups = forecast(state).waves.flatMap(w => w.lanes.flat()).filter(g => g.kind === key);
  const hp = [...new Set(groups.map(g => String(g.bodyHp)))];
  const choices = hp.length < 2 ? hp[0] : `${hp.slice(0, -1).join(', ')} or ${hp.at(-1)}`;
  const copy = enemyLessons[key].copy;
  if (key === 'brute') return copy.replace(`${C.BRUTE_HP} HP and up`, hp.length ? `${choices} HP in the scout window` : 'HP scales with the wave');
  if (key === 'swarm' && hp.length) return copy.replace(`${C.SWARM_HP} HP early and a little more later`, `${choices} HP in the scout window`);
  return copy;
}

export const heavyHelp = `Heavy lane: an extra Brute group from wave ${C.BRUTE_FROM}; two Brutes from wave ${C.HEAVY_BRUTE_FROM}. From wave ${C.LATE_FROM}, its Brutes get ${C.LATE_LEADER_HP_STEP} more HP per wave after wave ${C.LATE_FROM - 1n}.`;
