import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHarness, summarize } from './chain-v1-harness.js';
import { hashFile } from './chain-v1-bench.js';
import { newRun, withPart, playTurn, type Action } from '../src/v1/sim.js';
const skipEmptyLanes = process.env.CHAIN_V1_SKIP_EMPTY !== '0';
const h = await createHarness({ skipEmptyLanes }), rows = [];
for (const [boardName, pattern] of Object.entries({ palisades: [3], ballistas: [1], cauldrons: [2], support: [1, 4, 3, 5, 2, 4, 6, 3], empty: [0] })) {
  for (const variant of ['rerolls', 'overclock', 'preboosted']) {
    if (variant !== 'rerolls' && !pattern.some(p => p >= 1 && p <= 3)) continue;
    const name = boardName + (variant === 'rerolls' ? '' : '-' + variant);
    await h.start((1n << 64n) - 1n);
    let s = { ...newRun((1n << 64n) - 1n, 'practice'), wave: 9n, gold: 500n };
    for (let c = 0; c < 16; c++) {
        const p = BigInt(pattern[c % pattern.length]);
        s = withPart(s, BigInt(c), p, p ? 3n : 0n);
    }
    const cells = Array.from({ length: 16 }, (_, i) => BigInt(i)).filter(c => { const p = (s.parts >> (c * 4n)) & 15n; return p >= 1n && p <= 3n; });
    if (variant === 'preboosted') s.overclocked = cells.reduce((n, c) => n | 1n << c, 0n);
    h.seed(s);
    const actions: Action[] = variant === 'overclock' ? cells.slice(0, 6).map(cell => ({ type: 'overclock', cell })) : Array.from({ length: 6 }, () => ({ type: 'reroll' }));
    const ref = playTurn(s, actions), out = await h.turn(s, actions);
    assert.deepEqual(h.read(), ref.state, name);
    assert.deepEqual(out.events, [ref.event], name);
    const skippedLaneTicks = [ref.frames[0], ...ref.frames.slice(0, -1)].reduce((n, frame) => n + [0n, 1n, 2n, 3n].filter(lane => !frame.groups.some(g => g.lane === lane && g.count > 0n && (g.status === 'active' || g.status === 'queued'))).length, 0);
    const row = { name, skippedLaneTicks, totalCu: out.receipts.reduce((n, r) => n + r.measurement.cu, 0), transactions: out.receipts.map(r => r.measurement), after: h.read(), lanes: ref.summary.lanes };
    rows.push(row);
    console.log(name, row.totalCu);
  }
}
const result = { constantsSha256: hashFile('src/v1/constants.ts'), skipEmptyLanes, metrics: summarize(h.measurements), rows };
writeFileSync(process.env.CHAIN_V1_WORST_OUT ?? '.tmp/chain-v1/worst-measurements.json', JSON.stringify(result, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2));
console.log('WORST', JSON.stringify(result.metrics));
