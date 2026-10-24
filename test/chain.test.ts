import { beforeAll, describe, expect, it } from 'vitest';
import { FailedTransactionMetadata } from 'litesvm';
import { buildKitRunInstruction } from '@jac0xb/ballista/kit';
import { generateKeyPairSigner, lamports, type Instruction } from '@solana/kit';
import {
  BALLISTA_ADDRESS, ENTRY_BYTES, buildPlayInstructions, buildStartInstructions,
  decodeRunState, getEntryAddress, parseWaveEvents,
} from '../src/chain/client.js';
import { PACK, mask } from '../src/chain/templates.js';
import { C, CELLS, PART, RNG, SECONDS_PER_DAY } from '../src/rules/constants.js';
import { emptyState, enemies, fightLane, play, roll, start, survey, type RunState } from '../src/rules/sim.js';
import { createHarness, exerciseRandomRuns, randomSource, summarizeMeasurements, type ChainHarness } from '../scripts/chain-harness.js';

describe('Ballista on-chain rules', () => {
  let h: ChainHarness;
  beforeAll(async () => { h = await createHarness(); }, 30_000);

  it('compiles and finalizes every template within hard limits', () => {
    expect(BALLISTA_ADDRESS).toBe('BLSTAmUBA29tcRUvoq5DBYxRhGptrnWPtfQW65RszRWR');
    for (const [name, template] of Object.entries(h.deployment.compiled)) {
      expect(template.stats.instructions, name).toBeLessThanOrEqual(128);
      expect(template.stats.registers, name).toBeLessThanOrEqual(64);
      expect(template.stats.maxExpandedCpis, name).toBeLessThanOrEqual(64);
      expect(template.stats.payloadBytes, name).toBeLessThanOrEqual(10_240);
      expect(h.svm.getAccount(h.deployment.addresses[name as keyof typeof h.deployment.addresses]).exists).toBe(true);
    }
  });

  it('matches state and complete events after every action in 200 random runs', async () => {
    const corpus = await exerciseRandomRuns(h, 200);
    expect(corpus.runs).toBe(200);
    expect(corpus.waves).toBeGreaterThanOrEqual(200);
    const metrics = summarizeMeasurements(h.measurements);
    expect(metrics.play.maxCu).toBeLessThan(200_000);
    expect(metrics.play.maxBytes).toBeLessThanOrEqual(1232);
    expect(metrics.play.maxAccounts).toBeLessThanOrEqual(64);
    console.log('CHAIN_CORPUS', JSON.stringify({ ...corpus, metrics }));
  }, 120_000);

  it('matches 256 dense full-grid fixtures at varied waves, including final waves', async () => {
    const random = randomSource(0x4de5e);
    await h.startRun();
    let terminal = 0, won = 0, quarry = 0;
    for (let sample = 0; sample < 256; sample++) {
      let grid = 0n;
      for (let i = 0n; i < CELLS; i++) grid |= BigInt(random(7)) << (i * 4n);
      const state: RunState = {
        ...emptyState(), day: BigInt(random(100_000)), wave: sample % 2 === 0 ? C.WAVES - 1n : BigInt(random(Number(C.WAVES))),
        walls: C.WALLS_START, grid, bestDay: sample % 3 === 0 ? 0n : BigInt(random(100_000)),
        bestScore: sample % 3 === 0 ? (1n << 64n) - 1n : 0n,
      };
      if (sample % 3 === 0) state.day = 0n;
      h.seed(state);
      const pick = BigInt(random(3)), cell = BigInt(random(16));
      const expected = play(state, state.wave, pick, cell);
      const sent = await h.playWave(state.wave, pick, cell);
      expect(h.read()).toEqual(expected.state);
      expect(h.events(sent.meta)).toEqual([expected.event]);
      if (expected.state.done) terminal++;
      if (expected.state.won) won++;
      if (expected.event.goldGain > 0n) quarry++;
    }
    expect(terminal).toBeGreaterThan(0);
    expect(won).toBeGreaterThan(0);
    expect(quarry).toBeGreaterThan(0);
  }, 60_000);

  it('surveys exact edge adjacency, watchtower rows, and every uniform part board', async () => {
    const random = randomSource(0xabc134);
    const boards = [0n, ...Object.values(PART).map(part => part * 0x1111111111111111n)];
    for (let i = 0; i < 100; i++) {
      let grid = 0n;
      for (let cell = 0; cell < 16; cell++) grid |= BigInt(random(7)) << BigInt(cell * 4);
      boards.push(grid);
    }
    for (const grid of boards) {
      const sent = await h.success([buildKitRunInstruction({ compiled: h.deployment.compiled.survey, templateAddress: h.deployment.addresses.survey, inputs: { grid }, accounts: {} })]);
      const bytes = sent.meta.returnData().data();
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const packed = view.getBigUint64(0, true) | (view.getBigUint64(8, true) << 64n);
      const expected = survey(grid);
      for (let lane = 0; lane < 4; lane++) {
        const block = packed >> (BigInt(lane) * PACK.surveyLane);
        expect(block & mask(PACK.st)).toBe(expected.st[lane]);
        expect((block >> PACK.st) & mask(PACK.aoe)).toBe(expected.aoe[lane]);
        expect((block >> (PACK.st + PACK.aoe)) & mask(PACK.shield)).toBe(expected.shield[lane]);
      }
      expect(packed >> (4n * PACK.surveyLane)).toBe(expected.goldGain);
    }
  }, 30_000);

  it('matches combat with zero damage, full AoE kills, and exhausted single-target damage', async () => {
    for (const w of [1n, C.BRUTE_FROM_WAVE, C.HEAVY_BRUTE_FROM_WAVE, C.WAVES]) {
      for (const [st, aoe, shield] of [
        [0n, 0n, 0n], [mask(PACK.st), 0n, 0n],
        [0n, mask(PACK.aoe), 0n], [1n, 1n, mask(PACK.shield)],
      ]) {
        const day = 21_234n, enemy = roll(day, w, RNG.SALT_ENEMIES);
        const laneStats = st | (aoe << PACK.st) | (shield << (PACK.st + PACK.aoe));
        let packedSurvey = 0n;
        for (let lane = 0n; lane < 4n; lane++) packedSurvey |= laneStats << (lane * PACK.surveyLane);
        const sent = await h.success([buildKitRunInstruction({
          compiled: h.deployment.compiled.fight, templateAddress: h.deployment.addresses.fight,
          inputs: { w, enemy, survey: packedSurvey }, accounts: {},
        })]);
        const bytes = sent.meta.returnData().data();
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let packed = view.getBigUint64(0, true) | (view.getBigUint64(8, true) << 64n);
        const expected = enemies(day, w);
        for (let lane = 0; lane < 4; lane++) {
          const take = (width: bigint) => { const value = packed & mask(width); packed >>= width; return value; };
          const actual = { swarm: take(PACK.swarm), brute: take(PACK.brute), sk: take(PACK.swarm), bk: take(PACK.brute), hit: take(PACK.hit) };
          expect(actual).toEqual(fightLane(expected.swarm[lane], expected.brute[lane], expected.swarmHp, expected.bruteHp, st, aoe, shield));
        }
      }
    }
  });

  async function expectRejected(instructions: Instruction[]) {
    const before = h.read();
    const sent = await h.send(instructions);
    expect(sent.result).toBeInstanceOf(FailedTransactionMetadata);
    expect(h.read()).toEqual(before);
    expect(parseWaveEvents({ logs: sent.meta.logs(), err: 'failed' }, h.deployment)).toEqual([]);
    return sent;
  }

  it('rejects stale wave, invalid pick/cell, and plays after done; failure changes nothing', async () => {
    h.setDay(22_000n);
    await h.startRun();
    for (const [wave, pick, cell] of [[1n, 0n, 0n], [0n, 3n, 0n], [0n, 0n, 16n], [0n, (1n << 64n) - 1n, 0n], [0n, 0n, (1n << 64n) - 1n]]) {
      await expectRejected(await buildPlayInstructions(h.deployment, h.payer, wave, pick, cell));
    }
    const finished = { ...h.read(), done: true };
    h.seed(finished);
    await expectRejected(await buildPlayInstructions(h.deployment, h.payer, finished.wave, 0n, 0n));
  });

  it('rejects another player registry and substituted helper addresses', async () => {
    const other = await generateKeyPairSigner();
    h.svm.airdrop(other.address, lamports(20_000_000n));
    await h.success(await buildStartInstructions(h.deployment, other));
    await h.startRun();
    const otherEntry = await getEntryAddress(h.deployment, other.address);
    const instructions = await buildPlayInstructions(h.deployment, h.payer, 0n, 0n, 0n);
    const substituted = instructions.map(ix => ({ ...ix, accounts: ix.accounts?.map(meta => meta.address === h.entryAddress ? { ...meta, address: otherEntry } : meta) }));
    await expectRejected(substituted);
    const wrongHelper = instructions.map(ix => ({ ...ix, accounts: ix.accounts?.map(meta => meta.address === h.deployment.addresses.prepare ? { ...meta, address: h.deployment.addresses.survey } : meta) }));
    await expectRejected(wrongHelper);
  });

  it('allows restart mid-run, pins day at start, and preserves best across restarts', async () => {
    h.setDay(25_000n, SECONDS_PER_DAY - 1n);
    await h.startRun();
    const before = h.read();
    h.setDay(25_001n);
    const expected = play(before, before.wave, 2n, 15n);
    const sent = await h.playWave(before.wave, 2n, 15n);
    expect(h.read()).toEqual(expected.state);
    expect(h.events(sent.meta)).toEqual([expected.event]);
    const best = { ...h.read(), bestDay: 24_999n, bestScore: 1234n };
    h.seed(best);
    const restarted = await h.startRun();
    expect(h.read()).toEqual(start(best, 25_001n * SECONDS_PER_DAY));
    expect(h.events(restarted.meta)).toEqual([]);
  });

  it('improves same-day best, retains a higher best, and replaces previous-day best', async () => {
    for (const [bestDay, bestScore] of [[27_000n, 0n], [27_000n, (1n << 64n) - 1n], [26_999n, (1n << 64n) - 1n]]) {
      const state: RunState = { ...emptyState(), day: 27_000n, wave: C.WAVES - 1n, walls: C.WALLS_START, grid: PART.CAULDRON * 0x1111111111111111n, bestDay, bestScore };
      h.seed(state);
      const expected = play(state, state.wave, 0n, 15n);
      await h.playWave(state.wave, 0n, 15n);
      expect(h.read()).toEqual(expected.state);
      expect(expected.state.done).toBe(true);
    }
  });

  it('matches permitted play on an unopened zero entry and rejects negative clocks', async () => {
    const fresh = await generateKeyPairSigner();
    h.svm.airdrop(fresh.address, lamports(20_000_000n));
    const expected = play(emptyState(), 0n, 0n, 15n);
    const sent = await h.success(await buildPlayInstructions(h.deployment, fresh, 0n, 0n, 15n));
    const entry = h.svm.getAccount(await getEntryAddress(h.deployment, fresh.address));
    if (!entry.exists) throw new Error('Missing entry');
    expect(decodeRunState({ data: Uint8Array.from(entry.data), owner: entry.programAddress, template: h.deployment.addresses.state, player: fresh.address })).toEqual(expected.state);
    expect(h.events(sent.meta)).toEqual([expected.event]);
    h.setDay(-1n);
    await expectRejected(await buildStartInstructions(h.deployment, h.payer));
  });

  it('validates registry identity and ignores unauthenticated or failed-transaction events', async () => {
    h.setDay(26_000n);
    await h.startRun();
    const sent = await h.playWave(0n, 1n, 15n);
    const logs = sent.meta.logs();
    expect(h.events(sent.meta)).toHaveLength(1);
    expect(parseWaveEvents({ logs, err: { InstructionError: [2, 'failed later'] } }, h.deployment)).toEqual([]);
    const outerEvent = logs.length - 1 - [...logs].reverse().findIndex(line => line.startsWith('Program data:'));
    expect(parseWaveEvents({ logs: logs.slice(0, outerEvent), err: null }, h.deployment)).toEqual([]);
    const entry = h.svm.getAccount(h.entryAddress);
    if (!entry.exists) throw new Error('Missing entry');
    expect(entry.data.length).toBe(ENTRY_BYTES);
    const valid = { data: Uint8Array.from(entry.data), owner: entry.programAddress, template: h.deployment.addresses.state, player: h.payer.address };
    expect(() => decodeRunState({ ...valid, owner: h.payer.address })).toThrow();
    expect(() => decodeRunState({ ...valid, data: valid.data.slice(1) })).toThrow();
    for (const offset of [0, 4, 5, 6, 8, 40, 120]) {
      const data = Uint8Array.from(valid.data); data[offset] ^= 255;
      expect(() => decodeRunState({ ...valid, data })).toThrow();
    }
    const helperOnly = await h.success([buildKitRunInstruction({
      compiled: h.deployment.compiled.settle, templateAddress: h.deployment.addresses.settle,
      inputs: { w: 1n, pick: 0n, cell: 0n, grid: 0n, walls: C.WALLS_START, gold: 0n, survey: 0n, fight: 0n }, accounts: {},
    })]);
    expect(h.events(helperOnly.meta)).toEqual([]);
  });
});
