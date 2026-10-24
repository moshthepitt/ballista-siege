import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PART as P } from '../src/v1/constants.js';
import { applyAction, fight, forecast, newRun, withPart, type EnemyGroup, type RunState } from '../src/v1/sim.js';
import { enemyDetails } from './insights.js';
import { supportingCells } from './parts.js';
import { hitSnapshot, makeTimeline, movementSnapshot, playTimeline, presentStorm, isStorm, STORM_HOLD_MS } from './replay.js';
import { foeMarkup, formationMarkup } from './ui/board.js';
import { auditLabelBoxes, type Rect } from './ui/layout.js';
import { bossSavings, chipText, groupTrack, liveVerdict, trampleWarnings, tileReadout } from './ui/model.js';
import { firstDifference, planMetrics, replanComparison, type Recap } from './ui/screens.js';
import { scoutMarkup, guideMarkup } from './ui/scout.js';

const wave10 = (seed: bigint) => ({ ...newRun(seed, 'practice'), wave: 9n });
const queued = forecast(wave10(13n)).waves[0].lanes.flat();
const boss = queued.find(g => g.kind === 'boss')!;

describe('RD4 permanent queue tracks', () => {
  it('uses the same columns and front-to-back tracks in incoming and cells, including a full-width boss', () => {
    const lane = queued.filter(g => g.lane === boss.lane);
    expect(lane.map(groupTrack)).toEqual([
      { column: '1', row: '5' }, { column: '2', row: '4' },
      { column: '1', row: '3' }, { column: '1 / -1', row: '1' },
    ]);
    for (const g of lane) expect(groupTrack(g)).toEqual(groupTrack({ ...g, order: g.order }));
    const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
    expect(css).toContain('grid-template-rows:repeat(5,var(--track-step))');
    expect(css).toContain('--track-step:9px');
  });

  it('keeps every monotone four-group position and legal one-cell transition disjoint', () => {
    const base = queued[0]; let transitions = 0;
    const lane = [0, 1, 2, 3].map(order => ({ ...base, id: BigInt(order), order: BigInt(order), kind: order === 3 ? 'boss' as const : 'brute' as const }));
    for (let p0 = 1; p0 <= 5; p0++) for (let p1 = p0; p1 <= 5; p1++) for (let p2 = p1; p2 <= 5; p2++) for (let p3 = p2; p3 <= 5; p3++) {
      const positions = [p0, p1, p2, p3];
      for (let moves = 0; moves < 16; moves++) {
        const after = positions.map((p, i) => p - (moves >> i & 1));
        if (after.some((p, i) => i && p < after[i - 1])) continue;
        for (let t = 0; t <= 1.001; t += .05) {
          const labels = lane.flatMap((g, i) => {
            if (!after[i]) return []; // Exiting chips yield to running bodies.
            const center = g.kind === 'boss' ? 38.5 : Number(g.order % 2n) ? 57.75 : 19.25;
            const width = g.kind === 'boss' ? 48 : 36;
            const top = (5 - positions[i] + (positions[i] - after[i]) * t) * 48 + (Number(groupTrack(g).row) - 1) * 9;
            return [{ name: String(g.id), pop: false, bounds: { left: center - width / 2, right: center + width / 2, top, bottom: top + 17 } }];
          });
          const errors = auditLabelBoxes(labels, {});
          if (errors.length) throw new Error(`${positions} / ${after} @ ${t}: ${errors}`);

        }
        transitions++;
      }
    }
    expect(transitions).toBeGreaterThan(500);
  });

  it('never overlaps interpolated chips for four-group lanes through all ten sim ticks, every fence placement/tier and seeds 4/13/12', () => {
    // Every combination of no fence/T1/T2/T3 at the four depths exercises every
    // possible blocker geometry. Weapons only remove units from these tracks.
    const sizes = [
      { width: 180, cell: 116, incoming: 140, step: 13, queueStep: 20, chip: 23, chipWidth: 68 },
      { width: 132, cell: 90, incoming: 110, step: 12, queueStep: 18, chip: 22, chipWidth: 60 },
      { width: 77, cell: 48, incoming: 60, step: 9, queueStep: 9, chip: 17, chipWidth: 36 },
    ];
    let samples = 0, fights = 0;
    for (const seed of [4n, 13n, 12n]) for (let code = 0; code < 256; code++) {
      let built: RunState = wave10(seed);
      for (let lane = 0n; lane < 4n; lane++) for (let depth = 0; depth < 4; depth++) {
        const tier = code >> (2 * depth) & 3;
        if (tier) built = withPart(built, lane * 4n + BigInt(depth), P.PALISADE, BigInt(tier));
      }
      const result = fight(built), timeline = makeTimeline(built, result.frames); fights++;
      for (const size of sizes) {
        const rect = (g: EnemyGroup): Rect => {
          const track = groupTrack(g), row = Number(track.row) - 1;
          const width = g.kind === 'boss' ? size.chipWidth + 5 : size.chipWidth;
          const center = g.kind === 'boss' ? size.width / 2 : size.width * (Number(g.order % 2n) ? .75 : .25);
          const top = g.pos === 5n || g.status === 'queued' ? row * size.queueStep
            : size.incoming + 4 + (4 - Number(g.pos)) * (size.cell + 4) + row * size.step;
          return { left: center - width / 2, right: center + width / 2, top, bottom: top + size.chip };
        };
        for (const step of timeline) {
          const after = movementSnapshot(step), hit = hitSnapshot(step);
          for (let lane = 0n; lane < 4n; lane++) {
            const survivors = after.filter(g => g.lane === lane && (g.status === 'queued' || g.status === 'active' && g.pos > 0n));
            const pairs = survivors.map(g => ({ g, start: rect(hit.find(p => p.id === g.id)!), end: rect(g) }));
            for (let sample = 0; sample <= 20; sample++) {
              const t = sample / 20;
              const labels = pairs.map(({ g, start, end }) => ({ name: String(g.id), pop: false, bounds: {
                left: start.left + (end.left - start.left) * t, right: start.right + (end.right - start.right) * t,
                top: start.top + (end.top - start.top) * t, bottom: start.bottom + (end.bottom - start.bottom) * t,
              } }));
              const collisions = auditLabelBoxes(labels, {});
              if (collisions.length) throw new Error(`seed ${seed}, fences ${code}, tick ${step.frame.tick}, lane ${lane}, width ${size.width}, t ${t}: ${collisions}`);
              samples++;
            }
          }
        }
      }
    }
    expect(fights).toBe(768); expect(samples).toBe(1_935_360);
  }, 30_000);
});

describe('RD4 enemy explanations and lane states', () => {
  it('ignores stale body HP for one unit and marks only a wounded front in a stack', () => {
    const g = { ...queued[0], count: 1n, hp: 2n, bodyHp: 4n };
    expect(chipText(g)).toBe('1× ♥2'); expect(foeMarkup(g)).not.toContain('front-hp');
    expect(foeMarkup(g)).not.toContain('>4</span>');
    const brutes = { ...g, kind: 'brute' as const, count: 3n, bodyHp: 19n, hp: 6n, bite: 3n, leak: 3n, splashArmor: 1n };
    expect(chipText(brutes)).toBe('3× ♥19'); expect(foeMarkup(brutes)).toContain('front-hp');
    expect(enemyDetails(brutes)).toBe('3 Brutes · 19 HP each · front unit 6 of 19 HP · bite 3 · leak 3 · armour 1');
    expect(foeMarkup({ ...g, count: 0n, hp: 0n })).toBe('');
    expect(formationMarkup(boss)).toContain('left:25%'); expect(formationMarkup(boss)).toContain('left:75%');
  });
  it('states the next exact boss saving beside quarter threshold ticks', () => {
    const gatebreaker = forecast({ ...newRun(13n, 'practice'), wave: 4n }).waves[0].lanes.flat().find(g => g.kind === 'boss')!;
    expect(bossSavings({ ...gatebreaker, hp: 34n })).toBe('34 HP survives → 7 walls · 7 more damage saves 1');
    expect(bossSavings({ ...gatebreaker, hp: 13n })).toBe('13 HP survives → 5 walls · 13 more damage saves 5');
  });
  it('moves boss badges from queued to attacking to down or leaked without losing ordinary leak totals', () => {
    expect(liveVerdict(0n, [boss]).text).toBe('Boss coming');
    expect(liveVerdict(0n, [{ ...boss, status: 'active' }]).text).toBe('Boss in lane');
    expect(liveVerdict(0n, [{ ...boss, status: 'dead', count: 0n }]).text).toBe('Boss down +8g');
    expect(liveVerdict(7n, [{ ...boss, status: 'leaked' }]).text).toBe('Leaked −8');
    expect(liveVerdict(3n, [{ ...queued[0], status: 'active' }]).text).toBe('Holding');
  });
});

describe('RD4 storm completion', () => {
  it.each([1, 2])('renders the final L4 Brute contact and holds its loss before summary at %i×', async speed => {
    let built = { ...newRun(13n, 'practice'), wave: 4n };
    for (const [cell, part, tier] of [[0n,P.FORGE,2n],[1n,P.BALLISTA,2n],[4n,P.CAULDRON,1n],[5n,P.PALISADE,1n],[8n,P.FORGE,1n],[9n,P.BALLISTA,2n],[10n,P.PALISADE,1n],[12n,P.CAULDRON,1n],[13n,P.PALISADE,1n]]) built = withPart(built,cell,part,tier);
    const last = makeTimeline(built, fight(built).frames).at(-1)!;
    const stormLanes = [...new Set(last.frame.leaks.filter(l => isStorm(last, l.group)).map(l => l.lane))];
    expect(stormLanes).toContain(3n);
    let clock = 0; const events: { lane?: bigint; kind: string; time: number }[] = [];
    await presentStorm(last, speed,
      lane => events.push({ lane, kind: 'charge', time: clock }),
      lane => events.push({ lane, kind: 'leak', time: clock }),
      async ms => { clock += ms; });
    events.push({ kind: 'summary', time: clock });
    expect(events.filter(e => e.kind === 'leak').map(e => e.lane)).toEqual(stormLanes);
    expect(events.at(-2)).toMatchObject({ lane: 3n, kind: 'leak' });
    expect(events.at(-1)!.time - events.at(-2)!.time).toBe(STORM_HOLD_MS / speed);
  });
  it('awaits an asynchronous contact even when the phase clock has already elapsed', async () => {
    const built = newRun(4n, 'practice'), timeline = makeTimeline(built, fight(built).frames).slice(0, 1);
    const order: string[] = []; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const playing = playTimeline(timeline, () => 1, () => false, async () => {
      await gate; order.push('contact');
    }, async () => { order.push('clock'); }).then(() => { order.push('summary'); });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(['clock']);
    release(); await playing; expect(order.at(-1)).toBe('summary');
  });
});

describe('RD4 forecasts and replanning', () => {
  it('derives the earliest trample warning from real forecast events and never invents storm tramples', () => {
    let built = wave10(13n);
    for (let cell = 0n; cell < 16n; cell++) built = withPart(built, cell, cell % 4n === 0n ? P.PALISADE : P.QUARRY, 1n);
    const frames = fight(built).frames, warnings = trampleWarnings(frames);
    expect(warnings.size).toBeGreaterThan(0);
    for (const [cell, tick] of warnings) {
      expect(tick).toBe(frames.find(f => f.tramples.some(t => t.cell === cell))!.tick);
      expect(cell % 4n).not.toBe(0n);
    }
    expect(trampleWarnings([{ tick: 9n, tramples: [{ cell: 2n, group: 0n, part: P.QUARRY }] }, { tick: 3n, tramples: [{ cell: 2n, group: 0n, part: P.QUARRY }] }]).get(2n)).toBe(3n);
  });
  it('states global trample, exact support bonuses, and the immediate next wave during settlement', () => {
    expect(guideMarkup()).toContain("An enemy that steps onto one of your parts switches it off until the next wave. A standing Palisade blocks entry until its HP reaches 0.");
    const state = { ...newRun(13n, 'practice'), wave: 5n };
    const html = scoutMarkup(state, false, true);
    expect(html).toContain('Next wave: W6'); for (const w of [6, 7, 8]) expect(html).toContain(`>W${w}</span>`);
    const forge = withPart(state, 0n, P.FORGE, 3n);
    expect(tileReadout(forge, 0n).pill).toBe('Bolt +6 · Splash +3');
  });
  it('highlights adjacent active Forges and the strongest row Watchtower only', () => {
    let state = withPart(wave10(13n), 5n, P.BALLISTA, 2n);
    for (const [cell, part, tier] of [[4n,P.FORGE,2n],[6n,P.FORGE,1n],[1n,P.WATCHTOWER,1n],[13n,P.WATCHTOWER,3n]]) state = withPart(state, cell, part, tier);
    expect(supportingCells(state, 5n)).toEqual([4n, 6n, 13n]);
    expect(supportingCells(state, 5n, 1n << 13n)).toEqual([4n, 6n, 1n]);
  });
  it('counts gross purchases and rerolls separately from sale refunds', () => {
    const start = { ...newRun(13n, 'practice'), gold: 100n };
    const actions = [{ type: 'buy' as const, slot: 0n, cell: 0n }, { type: 'sell' as const, cell: 0n }, { type: 'reroll' as const }];
    const built = actions.reduce((s, a) => applyAction(s, a), start), result = fight(built);
    expect(start.gold - built.gold).toBe(4n);
    expect(planMetrics({ start, built, actions, result, timeline: makeTimeline(built, result.frames) })).toMatchObject({ spent: 6n, actions: 3n });
  });
  it('preserves both action queues, compares actual losses/spending/actions and starts at the first changed combat tick', () => {
    const start = { ...newRun(13n, 'practice'), gold: 100n };
    const recap = (actions: Recap['actions']): Recap => {
      const built = actions!.reduce((s, a) => applyAction(s, a), start), result = fight(built);
      return { start, built, actions, result, timeline: makeTimeline(built, result.frames) };
    };
    const original = recap([{ type: 'buy', slot: 0n, cell: 1n }]);
    const revised = { ...recap([{ type: 'buy', slot: 0n, cell: 2n }]), original, beforeLoss: planMetrics(original).loss };
    const frozen = structuredClone(original), index = firstDifference(original, revised);
    expect(planMetrics(original).spent).toBe(5n); expect(planMetrics(revised).actions).toBe(1n);
    expect(index).toBeGreaterThan(0); expect(index).toBeLessThan(10);
    const html = replanComparison(revised);
    for (const label of ['Original', 'Revised', 'Walls lost', 'Gold spent', 'Actions used', 'Replay from first difference', 'L1 D2', 'L1 D3']) expect(html).toContain(label);
    expect(original).toEqual(frozen);
  });
});
