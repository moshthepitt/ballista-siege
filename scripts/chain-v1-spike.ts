import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { compileTemplate, defineTemplate } from '@jac0xb/ballista';
import { ComputeBudget } from 'litesvm';
import { harness } from '../.tmp/spike/harness.js';
import { fireTemplate, biteTemplate, moveTemplate, surveyTemplate, boardTemplate, laneTemplate } from '../src/chain-v1/combat.js';
import { BALLISTA_ADDRESS, e, step, u, w, v, inp, wideGet, enc, wide, inputs, accounts, call } from '../src/chain-v1/vm.js';
import type { Address } from '@solana/kit';
import { C, LIMITS as L, PART as P } from '../src/v1/constants.js';
import { newRun, withPart, waveForecast, fight } from '../src/v1/sim.js';
const h = await harness();
h.svm.withLogBytesLimit(1000000n);
const defs = { fire: fireTemplate(), bite: biteTemplate(), move: moveTemplate(), survey: surveyTemplate(), board: boardTemplate() };
const deps: Record<string, Awaited<ReturnType<typeof h.upload>>> = Object.fromEntries(await Promise.all(Object.entries(defs).map(async ([name, t]) => [name, await h.upload(t)])));
const keys: Record<string, Address> = { ballista: BALLISTA_ADDRESS, ...Object.fromEntries(Object.entries(deps).map(([name, d]) => [name, d.address])) };
const laneDef = laneTemplate({ fire: keys.fire, bite: keys.bite, move: keys.move, survey: keys.survey }), lane = await h.upload(laneDef);
keys.lane = lane.address;
const forwarded = ['ballista', 'fire', 'bite', 'move', 'survey'];
const driverDef = defineTemplate({ inputs: inputs(['parts', 'tiers', 'queue', 'kinds', 'hp', 'wave', 'overclocked'], ['queue']), accounts: accounts(keys), steps: [
        step.let('queue', inp('queue')), step.let('hp', inp('hp')), step.let('disabled', u(0)), step.let('damage', u(0)), step.let('kills', u(0)), step.let('bounty', u(0)),
        step.repeat(u(L.TICKS), [
            call('board', [enc(inp('parts')), enc(inp('tiers')), enc(v('disabled'))]), step.let('board', e.returnData('u128')),
            call('lane', [enc(wideGet(v('board'), 0, 64)), enc(wideGet(v('board'), 64, 64)), enc(u(0)), wide(v('queue')), enc(inp('kinds')), enc(v('hp')), enc(e.add(e.loopIndex(), u(1))), enc(inp('wave')), enc(inp('overclocked'))], forwarded), step.let('out', e.returnData('u128')),
            step.assign('queue', e.bitAnd(v('out'), w((1n << 80n) - 1n))), step.assign('hp', wideGet(v('out'), 80, 24)),
            step.assign('disabled', e.bitOr(v('disabled'), wideGet(v('out'), 104, 4))), step.assign('damage', e.add(v('damage'), wideGet(v('out'), 108, 8))),
            step.assign('kills', e.add(v('kills'), wideGet(v('out'), 116, 4))), step.assign('bounty', e.add(v('bounty'), wideGet(v('out'), 120, 4))),
        ], { max: L.TICKS, carry: ['queue', 'hp', 'disabled', 'damage', 'kills', 'bounty'] }),
        step.setReturnData([enc(v('damage')), enc(v('kills')), enc(v('bounty')), enc(v('disabled')), enc(v('hp'))])
    ] });
const driver = await h.upload(driverDef);
const budget = new ComputeBudget();
budget.computeUnitLimit = 10000000n;
budget.maxInstructionTraceLength = 64n;
budget.maxInstructionStackDepth = 5n;
h.svm.withComputeBudget(budget);
const records = [];
let normalFailure: { cu: number; err: string | null; trace: number } | undefined;
for (const parts of [[1, 2, 3, 4], [3, 3, 3, 3], [2, 2, 2, 2], [1, 1, 1, 1], [4, 5, 6, 3], [0, 0, 0, 0]]) {
    let s = { ...newRun(12345n, 'practice'), wave: 9n };
    for (let c = 0; c < 4; c++)
        s = withPart(s, BigInt(c), BigInt(parts[c]), parts[c] ? 3n : 0n);
    const forecast = waveForecast(s.seed, s.wave + 1n), gs = forecast.lanes[0];
    let queue = 0n, kinds = 0n, hp = 0n;
    gs.forEach((g, j) => { const k = g.kind === 'swarm' ? 0n : g.kind === 'brute' ? 1n : 2n; kinds |= k << BigInt(j * 2); queue |= (g.count << 3n | g.hp << 6n | (k === 2n ? 0n : g.bodyHp) << 14n) << BigInt(j * 20); });
    for (let c = 0; c < 4; c++)
        if (parts[c] === Number(P.PALISADE))
            hp |= (C.PALISADE_HP * 3n) << BigInt(c * 6);
    const out = await h.run(driver, { parts: s.parts, tiers: s.tiers, queue, kinds, hp, wave: s.wave + 1n, overclocked: s.overclocked ?? 0n }, Object.fromEntries(Object.entries(keys).map(([name, address]) => [name, { address }])), 10000000);
    assert.ok(out.ok, out.err + '\n' + out.meta.logs().join('\n'));
    const ref = fight(s), view = new DataView(out.data.buffer, out.data.byteOffset, out.data.byteLength);
    const got = { damage: view.getBigUint64(0, true), kills: view.getBigUint64(8, true), bounty: view.getBigUint64(16, true), disabled: view.getBigUint64(24, true), hp: view.getBigUint64(32, true) };
    assert.equal(got.damage, ref.summary.lanes[0].damage);
    assert.equal(got.kills, ref.summary.lanes[0].kills);
    assert.equal(got.disabled, ref.frames.at(-1)!.disabled & 15n);
    const record = { parts, cu: out.cu, bytes: out.bytes, accounts: out.accounts, trace: out.trace, got };
    records.push(record);
    console.log(record);
    if (!normalFailure) {
        const normal = new ComputeBudget();
        normal.computeUnitLimit = 1350000n;
        normal.maxInstructionTraceLength = 64n;
        normal.maxInstructionStackDepth = 5n;
        h.svm.withComputeBudget(normal);
        const failed = await h.run(driver, { parts: s.parts, tiers: s.tiers, queue, kinds, hp, wave: s.wave + 1n, overclocked: s.overclocked ?? 0n }, Object.fromEntries(Object.entries(keys).map(([name, address]) => [name, { address }])), 1350000);
        assert.equal(failed.ok, false, 'A full lane must exceed the normal turn budget');
        normalFailure = { cu: failed.cu, err: failed.err, trace: failed.trace };
        writeFileSync('.tmp/chain-v1/lane-budget-failure.log', failed.meta.logs().join('\n'));
        h.svm.withComputeBudget(budget);
    }
}
const stats = Object.fromEntries(Object.entries({ ...defs, lane: laneDef, driver: driverDef }).map(([name, t]) => [name, { ...compileTemplate(t).stats, loops: t.steps.filter(s => s.kind === 'repeat').length }]));
const result = { stats, records, normalFailure, fullTurnExtrapolation: Math.max(...records.map(r => r.cu)) * 4, overheadAllowance: 200000 };
writeFileSync('.tmp/chain-v1/early-compute.json', JSON.stringify(result, (_, x) => typeof x === 'bigint' ? x.toString() : x, 2));
console.log('FOUR LANES ESTIMATE', result.fullTurnExtrapolation, 'PLUS ACTIONS/SETTLE', result.overheadAllowance);
