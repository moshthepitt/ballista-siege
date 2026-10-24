import { C } from '../src/v1/constants.js';
import type { Recap } from './ui/screens.js';

export interface LastTry { version: 1; seed: string; walls: number[]; losses: number[] }
export interface TryStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const key = (seed: bigint) => `ballista:siege:last-try:${seed}`;
const storage = (): TryStorage | undefined => { try { return localStorage; } catch { return undefined; } };
export function readLastTry(seed: bigint, source = storage()): LastTry | undefined {
  try {
    const r = JSON.parse(source?.getItem(key(seed)) ?? 'null') as LastTry | null;
    if (!r || r.version !== 1 || r.seed !== String(seed) || !Array.isArray(r.walls) || !Array.isArray(r.losses) || !r.walls.length || r.walls.length > 10 || r.walls.length !== r.losses.length) return;
    let previous = Number(C.START_WALLS);
    for (let i = 0; i < r.walls.length; i++) {
      if (!Number.isInteger(r.walls[i]) || r.walls[i] < 0 || r.walls[i] > previous || r.losses[i] !== previous - r.walls[i]) return;
      previous = r.walls[i];
    }
    return r;
  } catch { return; }
}
/** Retry saves one completed attempt per seed; replans never call this. */
export function saveLastTry(seed: bigint, recaps: readonly Recap[], source = storage()): LastTry | undefined {
  if (!recaps.length || recaps.some((r, i) => r.result.state.wave !== BigInt(i + 1) || r.built.seed !== seed)) return;
  const record: LastTry = { version: 1, seed: String(seed), walls: recaps.map(r => Number(r.result.state.walls)), losses: recaps.map(r => Number(r.built.walls - r.result.state.walls)) };
  try { source?.setItem(key(seed), JSON.stringify(record)); } catch { /* Comparison still works for this session. */ }
  return record;
}
export function lastTryChallenge(record?: LastTry): string {
  if (!record) return '';
  const loss = Math.max(...record.losses), wave = record.losses.indexOf(loss) + 1;
  return `Last try: W${wave} −${loss} walls`;
}
export function lastTryDelta(record: LastTry | undefined, wave: bigint, walls: bigint): string {
  const previous = record?.walls[Number(wave) - 1];
  if (previous === undefined) return '';
  const delta = Number(walls) - previous;
  return `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta)} vs last try`;
}
