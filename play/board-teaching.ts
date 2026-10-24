import { C, LIMITS as L, PART as P } from '../src/v1/constants.js';
import { fight, forecast, neighbors, partAt, tierAt, withPart, type RunState } from '../src/v1/sim.js';
import { isWeapon, statsAt } from './parts.js';

export interface SupportLink { from: bigint; to: bigint; bonus: bigint; kind: 'forge' | 'tower' }
/** One tower supplies a row. Equal strongest towers never double the bonus. */
export function supportLinks(state: RunState, disabled = 0n): SupportLink[] {
  const active = (cell: bigint) => !(disabled & (1n << cell));
  const links: SupportLink[] = [];
  for (let to = 0n; to < BigInt(L.CELLS); to++) {
    const weapon = partAt(state, to);
    if (!isWeapon(weapon) || !active(to)) continue;
    for (const from of neighbors(to)) if (active(from) && partAt(state, from) === P.FORGE) {
      links.push({ from, to, kind: 'forge', bonus: tierAt(state, from) * tierAt(state, to) * (weapon === P.BALLISTA ? C.FORGE_BALLISTA : C.FORGE_CAULDRON) });
    }
    const towers = Array.from({ length: L.LANES }, (_, lane) => BigInt(lane) * 4n + to % 4n)
      .filter(cell => active(cell) && partAt(state, cell) === P.WATCHTOWER)
      .sort((a, b) => Number(tierAt(state, b) - tierAt(state, a)) || Number(a - b));
    if (towers.length) links.push({ from: towers[0], to, kind: 'tower', bonus: tierAt(state, towers[0]) * C.WATCH_DAMAGE * tierAt(state, to) });
  }
  return links;
}
export function boostedWeapons(before: RunState, after: RunState): { cell: bigint; bonus: bigint; damage: bigint }[] {
  return Array.from({ length: L.CELLS }, (_, i) => BigInt(i)).filter(cell => isWeapon(partAt(before, cell)))
    .map(cell => ({ cell, bonus: statsAt(after, cell).value - statsAt(before, cell).value, damage: statsAt(after, cell).value }))
    .filter(row => row.bonus > 0n);
}
/** A picked card has a concrete range preview on touch before the first tap buys it. */
export function suggestedPlacement(state: RunState, part: bigint): bigint | null {
  const empty = Array.from({ length: L.CELLS }, (_, i) => BigInt(i)).filter(cell => !partAt(state, cell));
  if (!empty.length) return null;
  if (part === P.PALISADE) {
    const ahead = empty.find(cell => cell % 4n > 0n && isWeapon(partAt(state, cell - 1n)));
    if (ahead !== undefined) return ahead;
  }
  if (part === P.FORGE || part === P.WATCHTOWER) return [...empty].sort((a, b) => {
    const gain = (cell: bigint) => boostedWeapons(state, withPart(state, cell, part, 1n)).reduce((n, row) => n + row.bonus, 0n);
    return Number(gain(b) - gain(a)) || Number(a - b);
  })[0];
  const threatened = forecast(state).waves[0]?.lanes ?? [];
  return empty.find(cell => cell % 4n === 1n && threatened[Number(cell / 4n)]?.length) ?? empty[0];
}
export function wallExplanation(state: RunState, lane: bigint): string {
  const incoming = forecast(state).waves[0]?.lanes[Number(lane)] ?? [];
  const result = fight(state), row = result.summary.lanes[Number(lane)], name = `Lane ${lane + 1n}`;
  if (!incoming.length) return `${name} holds: no enemies come down it this wave.`;
  if (!row.damage) return `${name} holds: your weapons kill all ${row.spawned} enemies before they reach the wall.`;
  const groups = result.frames.at(-1)!.groups.filter(g => g.lane === lane && g.status === 'leaked');
  const survivors = groups.map(g => `${g.count} ${g.kind === 'boss' ? g.bossPattern === 'gatebreaker' ? 'Gatebreaker' : 'Last Siege' : g.kind === 'swarm' ? 'Swarm' : 'Brute'}${g.kind === 'boss' ? ` (${g.hp} HP left)` : ''}`).join(' and ');
  const weapons = Array.from({ length: L.DEPTHS }, (_, d) => partAt(state, lane * 4n + BigInt(d))).some(isWeapon);
  return `${name} leaks ${row.damage}: ${survivors} reach the wall${weapons ? ' after surviving your weapons.' : ' and nothing covers D1 to D4.'}`;
}
