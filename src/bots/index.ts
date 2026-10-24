import { C } from '../rules/constants.js';
import { emptyState, play, start, type RunState, type WaveEvent } from '../rules/sim.js';
import { boardOf, damage, legalMoves, partAt, place, positionOf, prepareDay, step, survey,
  type Day, type Move, type Position } from './kernel.js';

export type BotName = 'random' | 'greedy' | 'heuristic' | 'expert';
export interface BotRun { bot: BotName; state: RunState; moves: Move[]; events: WaveEvent[]; states: RunState[] }
export interface SearchOptions { width?: number; foresight?: number; mutations?: number }

// Local seed; reproducible and separate from the game's offers/enemy RNG.
export function seededRandom(seed: number): () => number {
  let x = (seed | 0) || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 0x100000000; };
}

export function randomMove(random: () => number): Move {
  return { pick: Math.floor(random() * 3), cell: Math.floor(random() * 16) };
}

export function greedyMove(p: Position, wave: number, d: Day): Move {
  let best = { pick: 0, cell: 0 }, bestWalls = -1, bestGold = -1, bestEmpty = -1;
  for (const move of legalMoves(d, wave)) {
    const n = step(p, wave, move, d), empty = partAt(p, move.cell) === 0 ? 1 : 0;
    if (n.walls > bestWalls || (n.walls === bestWalls && (n.gold > bestGold ||
        (n.gold === bestGold && empty > bestEmpty)))) {
      best = move; bestWalls = n.walls; bestGold = n.gold; bestEmpty = empty;
    }
  }
  return best;
}

// Forecast an unchanged board against later waves. This rewards support before its
// current-wave damage threshold matters. Gold keeps the rules' one-point weight.
function potential(p: Position, wave: number, d: Day, foresight: number): number {
  const s = survey(p, d.rules), left = d.waves.length - wave - 1;
  let futureDamage = 0;
  for (let ahead = 1; ahead <= Math.min(3, left); ahead++) {
    futureDamage += damage(s, d.waves[wave + ahead], d.rules) / ahead;
  }
  return p.walls * 10 + p.gold + s.goldGain * left * 0.8 - foresight * futureDamage;
}

export function heuristicMove(p: Position, wave: number, d: Day): Move {
  let best = { pick: 0, cell: 0 }, bestValue = -Infinity;
  for (const move of legalMoves(d, wave)) {
    const n = step(p, wave, move, d);
    let value = n.walls === 0 ? -1e6 + n.gold : potential(n, wave, d, 5);
    if (n.walls > 0 && wave + 1 < d.waves.length) {
      value = -Infinity;
      for (const next of legalMoves(d, wave + 1)) {
        const nn = step(n, wave + 1, next, d);
        value = Math.max(value, nn.walls === 0 ? -1e6 + nn.gold : potential(nn, wave + 1, d, 5));
      }
    }
    if (value > bestValue) { bestValue = value; best = move; }
  }
  return best;
}

interface Node extends Position { moves: Move[]; value: number }

// Full-run beam search, with every future offer and wave available. Failure to
// find a win is an upper bound on unwinnable days, never an impossibility proof.
function beamPlan(d: Day, options: SearchOptions): Move[] {
  const width = options.width ?? 80, foresight = options.foresight ?? 6;
  let beam: Node[] = [{ ...boardOf(C.STARTING_GRID), walls: d.rules.WALLS_START, gold: 0, moves: [], value: 0 }];
  let bestDone: Node | undefined;
  for (let wave = 0; wave < d.waves.length && beam.length; wave++) {
    const candidates = new Map<string, Node>(), moves = legalMoves(d, wave);
    for (const p of beam) for (const move of moves) {
      const n = step(p, wave, move, d);
      const value = n.walls === 0 ? -1e8 + wave * 1e5 + n.gold : potential(n, wave, d, foresight);
      const node = { ...n, value, moves: [...p.moves, move] };
      if (n.walls === 0 || wave === d.waves.length - 1) {
        const terminalValue = n.walls > 0 ? 1e9 + n.walls * 10 + n.gold : value;
        if (!bestDone || terminalValue > bestDone.value) bestDone = { ...node, value: terminalValue };
        if (n.walls === 0) continue;
      }
      const key = `${n.lo}:${n.hi}`;
      const previous = candidates.get(key);
      if (!previous || node.value > previous.value) candidates.set(key, node);
    }
    beam = [...candidates.values()].sort((a, b) => b.value - a.value).slice(0, width);
  }
  return bestDone?.moves ?? [];
}

// Optimize whole scripts, including changes that pay off many waves later.
// Signed final walls give failed plans a gradient; positive final walls imply
// every prefix also survived because damage is nonnegative.
function scriptValue(plan: Move[], d: Day): number {
  let board = boardOf(C.STARTING_GRID), walls = d.rules.WALLS_START, gold = 0;
  for (let wave = 0; wave < d.waves.length; wave++) {
    const move = plan[wave];
    board = place(board, move.cell, d.waves[wave].offers[move.pick]);
    const s = survey(board, d.rules);
    walls -= damage(s, d.waves[wave], d.rules); gold += s.goldGain;
  }
  return walls > 0 ? 1e6 + walls * 10 + gold : walls * 10 + gold * 0.02;
}

function fillPlan(prefix: Move[], d: Day): Move[] {
  const plan = [...prefix];
  let p: Position = { ...boardOf(C.STARTING_GRID), walls: 1e9, gold: 0 };
  for (let w = 0; w < d.waves.length; w++) {
    if (!plan[w]) plan[w] = greedyMove(p, w, d);
    p = step(p, w, plan[w], d); p.walls = 1e9;
  }
  return plan;
}

export function expertPlan(d: Day, options: SearchOptions = {}): Move[] {
  const random = seededRandom(Number(d.day & 0xffffffffn) ^ 0x7e57);
  const moves = d.waves.map((_, w) => legalMoves(d, w));
  const polish = (initial: Move[]): { plan: Move[]; value: number } => {
    let plan = [...initial], value = scriptValue(plan, d);
    for (let pass = 0; pass < 3; pass++) {
      let improved = false;
      for (let wave = 0; wave < d.waves.length; wave++) {
        const original = plan[wave]; let best = original;
        for (const move of moves[wave]) {
          plan[wave] = move;
          const candidate = scriptValue(plan, d);
          if (candidate > value) { value = candidate; best = move; improved = true; }
        }
        plan[wave] = best;
      }
      if (!improved) break;
    }
    return { plan, value };
  };
  let best = polish(fillPlan(beamPlan(d, options), d));
  const greedy = polish(fillPlan([], d));
  if (greedy.value > best.value) best = greedy;
  let current = best;
  const iterations = options.mutations ?? 300;
  for (let i = 0; i < iterations; i++) {
    const plan = [...current.plan];
    for (let j = 0; j < 2 + (i % 3 === 0 ? 1 : 0); j++) {
      const w = Math.floor(random() * d.waves.length);
      plan[w] = moves[w][Math.floor(random() * moves[w].length)];
    }
    const value = scriptValue(plan, d);
    // Modest downhill moves escape placement traps. Hard survival boundary stays.
    const temperature = 12 * (1 - i / iterations);
    if (value >= current.value || (Math.abs(value - current.value) < 10000 &&
        random() < Math.exp((value - current.value) / Math.max(0.01, temperature)))) current = { plan, value };
    if (current.value > best.value) best = current;
    if (i % 75 === 74) current = best;
  }
  return polish(best.plan).plan;
}

export function runBot(day: bigint, bot: BotName, options: SearchOptions = {}, prepared?: Day): BotRun {
  const d = prepared ?? prepareDay(day), random = seededRandom(Number(day & 0xffffffffn) ^ 0x51e9e);
  const plan = bot === 'expert' ? expertPlan(d, options) : [];
  let state = start(emptyState(), day * 86400n);
  const moves: Move[] = [], events: WaveEvent[] = [], states: RunState[] = [state];
  while (!state.done) {
    const wave = Number(state.wave), p = positionOf(state);
    const move = bot === 'random' ? randomMove(random) : bot === 'greedy' ? greedyMove(p, wave, d)
      : bot === 'heuristic' ? heuristicMove(p, wave, d) : plan[wave];
    if (!move) throw new Error(`Expert plan missing move on day ${day}, wave ${wave}`);
    const expected = step(p, wave, move, d);
    const result = play(state, state.wave, BigInt(move.pick), BigInt(move.cell));
    if (Number(result.state.walls) !== expected.walls || Number(result.state.gold) !== expected.gold ||
        result.state.grid !== (BigInt(expected.lo) | (BigInt(expected.hi) << 32n))) {
      throw new Error(`Search/reference mismatch on day ${day}, wave ${wave + 1}`);
    }
    moves.push(move); events.push(result.event); state = result.state; states.push(state);
  }
  return { bot, state, moves, events, states };
}
