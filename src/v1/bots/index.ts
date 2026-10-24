import { BOT, C, LIMITS as L, PART as P, PRICE } from '../constants.js';
import { applyAction, evaluateFight, fight, neighbors, partAt, shop, tierAt, upgradeCost, waveForecast, xorshift,
  type Action, type RunState } from '../sim.js';

export type Bot = (state: RunState) => Action[];
export interface PlannerOptions { excludeParts?: readonly bigint[]; upgrades?: boolean; overclock?: boolean }

/** Enumerate actual legal actions, including sell and reroll. Never changes its input. */
export function legalActions(s: RunState): Action[] {
  if (s.done || s.actionsUsed >= BigInt(L.ACTIONS)) return [];
  const actions: Action[] = [];
  for (let cell = 0n; cell < 16n; cell++) {
    const p = partAt(s, cell), t = tierAt(s, cell);
    if (p === 0n) for (const o of shop(s)) {
      if (o.available && o.price <= s.gold) actions.push({ type: 'buy', slot: o.slot, cell });
    }
    else {
      if (t < 3n && upgradeCost(p, t) <= s.gold) actions.push({ type: 'upgrade', cell });
      if (t === 3n && p <= P.PALISADE && s.gold >= C.OVERCLOCK_COST && ((s.overclocked ?? 0n) & (1n << cell)) === 0n) actions.push({ type: 'overclock', cell });
      actions.push({ type: 'sell', cell });
    }
  }
  if (s.gold >= s.rerolls + 1n) actions.push({ type: 'reroll' });
  return actions;
}

export const random: Bot = s => {
  let state = s, r = xorshift(s.seed ^ ((s.wave + 1n) * 114007n) ^ 0x12345678n);
  const actions: Action[] = [], count = 1 + Number(r % 3n);
  for (let i = 0; i < count; i++) {
    r = xorshift(r);
    // Random player spends on things, without a preference for a part or position.
    const choices = legalActions(state).filter(a => a.type !== 'sell');
    if (!choices.length) break;
    const a = choices[Number(r % BigInt(choices.length))];
    actions.push(a); state = applyAction(state, a);
  }
  return actions;
};

function boardValue(s: RunState): number {
  let value = 0;
  for (let i = 0n; i < 16n; i++) {
    const p = partAt(s, i), t = Number(tierAt(s, i));
    if (!p) continue;
    let invested: bigint = PRICE[Number(p)];
    if (t >= 2) invested += upgradeCost(p, 1n);
    if (t >= 3) invested += upgradeCost(p, 2n);
    value += Number(invested);
    if (p === P.BALLISTA || p === P.CAULDRON) {
      let forge = 0, watch = 0;
      for (const n of neighbors(i)) if (partAt(s, n) === P.FORGE) forge += Number(tierAt(s, n));
      for (let lane = 0n; lane < 4n; lane++) {
        const n = lane * 4n + i % 4n;
        if (partAt(s, n) === P.WATCHTOWER) watch = Math.max(watch, Number(tierAt(s, n)));
      }
      const base = Number(p === P.BALLISTA ? C.BALLISTA_DAMAGE : C.CAULDRON_DAMAGE);
      const buff = Number(p === P.BALLISTA ? C.FORGE_BALLISTA : C.FORGE_CAULDRON);
      // Value an engine that can use future upgrades, beyond the next exact kill threshold.
      value += (base + buff * forge + Number(C.WATCH_DAMAGE) * watch) * t * (watch ? 5 / 3 : 1) * BOT.ENGINE_VALUE;
    }
  }
  return value;
}

function evaluate(s: RunState, planning: boolean, result = evaluateFight(s)): number {
  const next = result.state;
  const left = L.WAVES - Number(s.wave), damage = Number(result.summary.damage);
  let v = -damage * 12 - damage * damage * 0.3 + Number(result.summary.kills) * 0.7;
  if (next.walls === 0n) v -= 2000;
  if (next.won) v += 2000;
  // Terminal gold has no score value. Final-turn purchases must improve combat.
  v += Number(next.gold) * (next.done ? 0 : planning ? 0.75 : 0.15);
  if (!planning) return v;
  // Three known waves, no imagined future purchases. This intentionally overestimates
  // future pressure; the economy/board terms give the search a way to prepare.
  if (!next.done) {
    const future = evaluateFight(next);
    v -= Number(future.summary.damage) * 7;
    v += Number(future.summary.kills) * 0.25;
    if (future.state.walls === 0n) v -= 250;
    if (!future.state.done) v += Number(future.summary.quarry) * Math.min(left - 2, 3) * BOT.QUARRY_FUTURE;
    if (!future.state.done) {
      const later = evaluateFight(future.state);
      v -= Number(later.summary.damage) * 4;
      if (later.state.walls === 0n) v -= 100;
    }
  }
  if (!next.done) {
    v += boardValue(s) * BOT.BOARD_VALUE;
    v += Number(result.summary.quarry) * Math.min(left - 1, 3) * BOT.QUARRY_NOW;
  }
  return v;
}

function placementValue(s: RunState, a: Action, threat: number[]): number {
  if (a.type === 'reroll') return -4;
  const p = a.type === 'buy' ? shop(s)[Number(a.slot)].part : partAt(s, a.cell);
  const lane = Number(a.cell / 4n), depth = Number(a.cell % 4n) + 1;
  if (a.type === 'sell') return -20;
  const adjacent = neighbors(a.cell);
  let v = threat[lane] * (p === P.BALLISTA || p === P.CAULDRON || p === P.PALISADE ? 0.2 : 0.02);
  const hasBlockerAhead = [2n, 3n, 4n].some(d => d > BigInt(depth) && partAt(s, BigInt(lane * 4) + d - 1n) === P.PALISADE);
  if (p === P.BALLISTA || p === P.CAULDRON) {
    v += depth <= 2 ? 3 : 0;
    // On tied openings, stagger back guns to leave shared Forge and Watchtower sites.
    if (depth <= 2 && (lane + depth) % 2 === 0) v += 0.5;
    if (hasBlockerAhead) v += 5;
    for (const n of adjacent) if (partAt(s, n) === P.FORGE) v += 3;
    if (a.type === 'upgrade') v += 2;
  } else if (p === P.PALISADE) {
    v += depth === 3 ? 6 : depth === 4 ? 3 : 0;
    for (let d = 1; d < depth; d++) {
      const other = partAt(s, BigInt(lane * 4 + d - 1));
      if (other === P.BALLISTA || other === P.CAULDRON) v += 4;
    }
  } else if (p === P.FORGE) {
    v += depth <= 2 ? 2 : 0;
    for (const n of adjacent) if (partAt(s, n) === P.BALLISTA || partAt(s, n) === P.CAULDRON) v += 7;
  } else if (p === P.WATCHTOWER) {
    for (let l = 0; l < 4; l++) {
      const other = partAt(s, BigInt(l * 4 + depth - 1));
      if (other === P.BALLISTA || other === P.CAULDRON) v += 6;
    }
  } else if (p === P.QUARRY) {
    v += depth === 1 ? 5 : 0;
    for (const n of adjacent) if (partAt(s, n) === P.QUARRY) v += 4;
    if (hasBlockerAhead) v += 3;
  }
  return v;
}

function candidates(s: RunState): Action[] {
  const threat = waveForecast(s.seed, s.wave + 1n).lanes.map(gs => gs.reduce((a, g) => a + Number(g.count * g.leak), 0));
  const actions = legalActions(s);
  // Keep two placements for each offered kind as well as the globally best moves.
  // This preserves support/blocker combinations without evaluating all 64 buys.
  const ranked = actions.map(a => ({ a, v: placementValue(s, a, threat) })).sort((a, b) => b.v - a.v);
  const chosen = ranked.slice(0, BOT.CANDIDATES).map(x => x.a);
  for (const o of shop(s)) {
    for (let lane = 0n; lane < 4n; lane++) {
      const x = ranked.find(x => x.a.type === 'buy' && x.a.slot === o.slot && x.a.cell / 4n === lane);
      if (x && !chosen.includes(x.a)) chosen.push(x.a);
      if (o.part === P.QUARRY) for (const x of ranked.filter(x => x.a.type === 'buy' && x.a.slot === o.slot
        && x.a.cell / 4n === lane && x.a.cell % 4n >= 2n)) if (!chosen.includes(x.a)) chosen.push(x.a);
    }
  }
  for (const x of ranked.filter(x => x.a.type === 'upgrade' || x.a.type === 'overclock')) if (!chosen.includes(x.a)) chosen.push(x.a);
  for (const x of ranked.filter(x => x.a.type === 'buy' && shop(s)[Number(x.a.slot)].part === P.PALISADE)) {
    if (!chosen.includes(x.a)) chosen.push(x.a);
  }
  const reroll = actions.find(a => a.type === 'reroll');
  if (reroll) chosen.push(reroll);
  // Sell only when space is scarce. Search can follow it with a replacement.
  if (actions.filter(a => a.type === 'buy').length < 4) chosen.push(...actions.filter(a => a.type === 'sell').slice(0, 4));
  return chosen;
}

export const greedy: Bot = s => {
  let state = s, value = evaluate(s, false);
  const actions: Action[] = [];
  for (let i = 0; i < L.ACTIONS; i++) {
    let best: { a: Action; s: RunState; v: number } | undefined;
    for (const a of candidates(state)) {
      if (a.type === 'sell' || a.type === 'reroll') continue;
      const ns = applyAction(state, a), v = evaluate(ns, false);
      if (v > value + 0.01 && (!best || v > best.v)) best = { a, s: ns, v };
    }
    if (!best) break;
    actions.push(best.a); state = best.s; value = best.v;
  }
  return actions;
};

/** Bounded beam over complete action prefixes, with a transposition cache per turn. */
export const planner = (s: RunState, options: PlannerOptions = {}): Action[] => {
  interface Node { state: RunState; actions: Action[]; value: number; objective: number }
  const final = s.wave === BigInt(L.WAVES - 1);
  if (final && evaluateFight(s).summary.damage === 0n) return [];
  const key = (s: RunState) => `${s.parts}/${s.tiers}/${s.gold}/${s.rerolls}/${s.bought}/${s.actionsUsed}/${s.overclocked ?? 0n}`;
  const values = new Map<string, { search: number; objective: number }>();
  const score = (s: RunState) => { const k = key(s); let v = values.get(k);
    if (v === undefined) {
      const result = final ? fight(s) : evaluateFight(s), objective = evaluate(s, true, result);
      let search = objective;
      // Keep prefixes that hurt a survivor before several actions earn its kill.
      // Partial HP guides the beam, but only walls/kills justify a final purchase.
      if (final) for (const g of result.frames.at(-1)!.groups) {
        if (g.count > 0n) search -= Number((g.count - 1n) * g.bodyHp + g.hp) / Number(g.maxHp) * Number(g.leak) * 12;
      }
      v = { search, objective }; values.set(k, v);
    }
    return v;
  };
  const allowed = (s: RunState, a: Action) => !(a.type === 'upgrade' && options.upgrades === false)
    && !(a.type === 'overclock' && options.overclock === false)
    && !(a.type === 'buy' && options.excludeParts?.includes(shop(s)[Number(a.slot)].part));
  function* continuations(state: RunState): Generator<Action[]> {
    for (const action of final ? legalActions(state) : candidates(state)) {
      if (!allowed(state, action)) continue;
      yield [action];
      // A sale alone loses firepower. Keep its replacement in the same search
      // prefix so a useful support swap survives the narrow beam.
      if (final && action.type === 'sell') {
        const sold = applyAction(state, action);
        for (const buy of legalActions(sold)) {
          if (buy.type === 'buy' && buy.cell === action.cell && allowed(sold, buy)) yield [action, buy];
        }
      }
    }
  }
  const initial = score(s);
  let best: Node = { state: s, actions: [], value: initial.search, objective: initial.objective }, beam = [best];
  for (let depth = 0; depth < BOT.DEPTH + (s.wave >= 6n ? 2 : 0); depth++) {
    const expanded: Node[] = [], seen = new Set<string>();
    for (const n of beam) for (const moves of continuations(n.state)) {
      const state = moves.reduce(applyAction, n.state), k = key(state);
      if (seen.has(k)) continue;
      seen.add(k);
      const actions = [...n.actions, ...moves], scored = score(state), cost = actions.length * BOT.ACTION_COST;
      const node = { state, actions, value: scored.search - cost, objective: scored.objective - cost }; expanded.push(node);
      if (node.objective > best.objective + 0.001) best = node;
    }
    expanded.sort((a, b) => b.value - a.value);
    beam = expanded.slice(0, BOT.BEAM);
    if (!beam.length) break;
  }
  // Forecast/investment credit must not leave an affordable immediate rescue unused.
  // Scan every legal placement, not the heuristic shortlist. Strict damage reduction
  // bounds this repair to the remaining action budget and prevents buy/sell cycles.
  let built = best.state, damage = evaluateFight(built).summary.damage;
  const actions = [...best.actions];
  while (damage > 0n && built.actionsUsed < BigInt(L.ACTIONS)) {
    let repair: { action: Action; state: RunState; damage: bigint; value: number } | undefined;
    for (const action of legalActions(built)) {
      if (!allowed(built, action) || action.type === 'sell' || action.type === 'reroll') continue;
      const state = applyAction(built, action), nextDamage = evaluateFight(state).summary.damage;
      if (nextDamage >= damage) continue;
      const value = score(state).objective;
      if (!repair || nextDamage < repair.damage || (nextDamage === repair.damage && value > repair.value)) {
        repair = { action, state, damage: nextDamage, value };
      }
    }
    if (!repair) break;
    actions.push(repair.action); built = repair.state; damage = repair.damage;
  }
  return actions;
};

export const bots = { random, greedy, planner };
