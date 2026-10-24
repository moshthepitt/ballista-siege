import {
  INSTRUCTION_RUN, account, addressBytes, compileTemplate, data, defineTemplate,
  expression as e, step, type Expression, type Step,
} from '@jac0xb/ballista';
import { BALLISTA_ADDRESS } from '@jac0xb/ballista/kit';
import type { Address } from '@solana/kit';
import { C, CELLS, LANES, PART, RNG, ROWS, SECONDS_PER_DAY } from '../rules/constants.js';

const U64 = (1n << 64n) - 1n;
const v = e.variable;
const u = e.u64;
const input = e.input;
const enc = (value: Expression) => data.encode('u64', value);
const wide = (value: Expression) => data.encode('u128', value);
const inputs = (names: string[], widths: string[] = []) => Object.fromEntries(
  names.map(name => [name, { type: widths.includes(name) ? 'u128' as const : 'u64' as const }]),
);

function bits(maximum: bigint): bigint {
  if (maximum < 0n || maximum > U64) throw new RangeError('Tuning exceeds checked u64');
  return BigInt(Math.max(1, maximum.toString(2).length));
}
const scaled = C.SWARM_NUM * C.WAVES / C.SWARM_DEN;
const swarmMax = C.SWARM_BASE + scaled + C.WAVES + C.SWARM_SPREAD - 1n + C.HEAVY_NUM * C.WAVES / C.HEAVY_DEN;
const bruteMax = 7n + 1n; // b >> 5 is at most 7; heavy contributes at most 1.
const hitMax = C.SWARM_LEAK * swarmMax + C.BRUTE_LEAK * bruteMax;

/** Widths are derived from tuning, never silently truncated. Offsets are wire format. */
export const PACK = (() => {
  const st = bits(ROWS * (C.BALLISTA_DMG + 4n * C.FORGE_ST + C.WATCH_BONUS));
  const aoe = bits(ROWS * (C.CAULDRON_DMG + 4n * C.FORGE_AOE));
  const shield = bits(ROWS * C.PALISADE_SHIELD);
  const gain = bits(CELLS * (C.QUARRY_GOLD + 4n * C.QUARRY_ADJ));
  const surveyLane = st + aoe + shield;
  const swarm = bits(swarmMax), brute = bits(bruteMax), hit = bits(hitMax);
  const fightLane = swarm * 2n + brute * 2n + hit;
  const walls = bits(C.WALLS_START);
  const gold = bits(C.WAVES * CELLS * (C.QUARRY_GOLD + 4n * C.QUARRY_ADJ));
  const score = bits(100n * C.WAVES + 10n * C.WALLS_START + ((1n << gold) - 1n));
  if (surveyLane * LANES + gain > 128n || fightLane * LANES > 128n || walls + gold + score > 128n) {
    throw new RangeError('Tuning exceeds 128-bit helper return format; widen/split helpers before deployment');
  }
  bits(hitMax * LANES);
  return { st, aoe, shield, gain, surveyLane, swarm, brute, hit, fightLane, walls, gold, score };
})();

export const mask = (width: bigint) => (1n << width) - 1n;
const extract = (value: Expression, offset: Expression, width: bigint) =>
  e.cast('u64', e.bitAnd(e.shiftRight(value, offset), e.u128(mask(width))));

function xorSteps(name: string, value: Expression): Step[] {
  return [
    step.let(`${name}a`, e.bitXor(value, e.shiftLeft(e.bitAnd(value, u(mask(51n))), u(13)))),
    step.let(`${name}b`, e.bitXor(v(`${name}a`), e.shiftRight(v(`${name}a`), u(7)))),
    step.let(name, e.bitXor(v(`${name}b`), e.shiftLeft(e.bitAnd(v(`${name}b`), u(mask(47n))), u(17)))),
  ];
}

/** Pure placement and both seeded rolls. Return low grid, high enemy roll. */
export const prepareTemplate = defineTemplate({
  inputs: inputs(['day', 'w', 'pick', 'cell', 'grid']),
  accounts: {},
  steps: [
    step.let('mix', e.add(e.multiply(input('day'), u(RNG.DAY_MUL)), e.multiply(input('w'), u(RNG.WAVE_MUL)))),
    step.let('offerSeed', e.bitXor(u(RNG.BASE), e.add(v('mix'), u(RNG.SALT_OFFERS)))),
    ...xorSteps('offerA', v('offerSeed')), ...xorSteps('offer', v('offerA')),
    step.let('enemySeed', e.bitXor(u(RNG.BASE), e.add(v('mix'), u(RNG.SALT_ENEMIES)))),
    ...xorSteps('enemyA', v('enemySeed')), ...xorSteps('enemy', v('enemyA')),
    step.let('offerIndex', e.bitAnd(e.shiftRight(v('offer'), e.multiply(input('pick'), u(16))), u(15))),
    step.let('part', e.bitAnd(e.shiftRight(u(C.OFFER_TABLE), e.multiply(v('offerIndex'), u(4))), u(15))),
    step.let('shift', e.multiply(input('cell'), u(4))),
    step.let('grid', e.bitOr(
      e.bitAnd(input('grid'), e.bitXor(u(U64), e.shiftLeft(u(15), v('shift')))),
      e.shiftLeft(v('part'), v('shift')),
    )),
    step.setReturnData([wide(e.bitOr(e.cast('u128', v('grid')), e.shiftLeft(e.cast('u128', v('enemy')), u(64))))]),
  ],
});

// Exact nibble equality, without the borrow propagation of the usual hasZero trick.
function matchNibbles(name: string, part: bigint): Step[] {
  return [
    step.let(`${name}x`, e.bitXor(input('grid'), u(part * 0x1111111111111111n))),
    step.let(name, e.bitAnd(e.shiftRight(e.bitXor(
      e.bitOr(e.add(e.bitAnd(v(`${name}x`), u(0x7777777777777777n)), u(0x7777777777777777n)), v(`${name}x`)),
      u(U64),
    ), u(3)), u(0x1111111111111111n))),
  ];
}

function adjacent(name: string, source: string): Step {
  return step.let(name, e.add(e.add(
    e.shiftLeft(e.bitAnd(v(source), u(0x0000ffffffffffffn)), u(16)), e.shiftRight(v(source), u(16)),
  ), e.add(
    e.shiftLeft(e.bitAnd(v(source), u(0x0111011101110111n)), u(4)),
    e.bitAnd(e.shiftRight(v(source), u(4)), u(0x0111011101110111n)),
  )));
}

/** Survey all 16 cells with SWAR adjacency counts and one carried packed sum. */
export const surveyTemplate = defineTemplate({
  inputs: inputs(['grid']), accounts: {},
  steps: [
    ...matchNibbles('forges', PART.FORGE), ...matchNibbles('quarries', PART.QUARRY),
    ...matchNibbles('watch', PART.WATCHTOWER),
    adjacent('adjForge', 'forges'), adjacent('adjQuarry', 'quarries'),
    step.let('watchHalf', e.bitOr(v('watch'), e.shiftRight(v('watch'), u(32)))),
    step.let('watched', e.bitAnd(e.bitOr(v('watchHalf'), e.shiftRight(v('watchHalf'), u(16))), u(0xffff))),
    step.let('totals', e.u128(0)),
    step.repeat(u(CELLS), [
      step.let('i', e.loopIndex()),
      step.let('shift', e.multiply(v('i'), u(4))),
      step.let('part', e.bitAnd(e.shiftRight(input('grid'), v('shift')), u(15))),
      step.let('forge', e.bitAnd(e.shiftRight(v('adjForge'), v('shift')), u(7))),
      step.let('watchedHere', e.notEqual(e.bitAnd(e.shiftRight(v('watched'), e.multiply(e.remainder(v('i'), u(ROWS)), u(4))), u(1)), u(0))),
      step.let('st', e.select(e.equal(v('part'), u(PART.BALLISTA)), e.add(
        e.add(u(C.BALLISTA_DMG), e.multiply(u(C.FORGE_ST), v('forge'))),
        e.select(v('watchedHere'), u(C.WATCH_BONUS), u(0)),
      ), u(0))),
      step.let('aoe', e.select(e.equal(v('part'), u(PART.CAULDRON)), e.add(u(C.CAULDRON_DMG), e.multiply(u(C.FORGE_AOE), v('forge'))), u(0))),
      step.let('shield', e.select(e.equal(v('part'), u(PART.PALISADE)), u(C.PALISADE_SHIELD), u(0))),
      step.let('gain', e.select(e.equal(v('part'), u(PART.QUARRY)), e.add(u(C.QUARRY_GOLD), e.multiply(u(C.QUARRY_ADJ), e.bitAnd(e.shiftRight(v('adjQuarry'), v('shift')), u(7)))), u(0))),
      step.let('laneValues', e.bitOr(e.bitOr(e.cast('u128', v('st')), e.shiftLeft(e.cast('u128', v('aoe')), u(PACK.st))), e.shiftLeft(e.cast('u128', v('shield')), u(PACK.st + PACK.aoe)))),
      step.assign('totals', e.add(v('totals'), e.add(
        e.shiftLeft(v('laneValues'), e.multiply(e.divide(v('i'), u(ROWS)), u(PACK.surveyLane))),
        e.shiftLeft(e.cast('u128', v('gain')), u(LANES * PACK.surveyLane)),
      ))),
    ], { max: Number(CELLS), carry: ['totals'] }),
    step.setReturnData([wide(v('totals'))]),
  ],
});

/** Resolve four lanes. Return packed swarm/brute/sk/bk/hit per lane. */
export const fightTemplate = defineTemplate({
  inputs: inputs(['w', 'enemy', 'survey'], ['survey']), accounts: {},
  steps: [
    step.let('heavy', e.bitAnd(e.shiftRight(input('enemy'), u(32)), u(3))),
    step.let('swarmHp', e.add(u(C.SWARM_HP_BASE), e.divide(input('w'), u(C.SWARM_HP_STEP)))),
    step.let('bruteHp', e.add(u(C.BRUTE_HP_BASE), e.multiply(u(C.BRUTE_HP_PER_WAVE), input('w')))),
    step.let('baseSwarm', e.add(u(C.SWARM_BASE), e.divide(e.multiply(u(C.SWARM_NUM), input('w')), u(C.SWARM_DEN)))),
    step.let('heavySwarm', e.divide(e.multiply(u(C.HEAVY_NUM), input('w')), u(C.HEAVY_DEN))),
    step.let('spread', e.add(input('w'), u(C.SWARM_SPREAD))),
    step.let('bruteDiv', e.add(e.divide(input('w'), u(C.BRUTE_DIV)), u(1))),
    step.let('totals', e.u128(0)),
    step.repeat(u(LANES), [
      step.let('lane', e.loopIndex()),
      step.let('b', e.bitAnd(e.shiftRight(input('enemy'), e.multiply(v('lane'), u(8))), u(255))),
      step.let('isHeavy', e.equal(v('lane'), v('heavy'))),
      step.let('swarm', e.add(e.add(v('baseSwarm'), e.remainder(v('b'), v('spread'))), e.select(v('isHeavy'), v('heavySwarm'), u(0)))),
      step.let('brute', e.add(
        e.select(e.greaterThanOrEqual(input('w'), u(C.BRUTE_FROM_WAVE)), e.remainder(e.shiftRight(v('b'), u(5)), v('bruteDiv')), u(0)),
        e.select(e.and(v('isHeavy'), e.greaterThanOrEqual(input('w'), u(C.HEAVY_BRUTE_FROM_WAVE))), u(1), u(0)),
      )),
      step.let('laneSurvey', e.shiftRight(input('survey'), e.multiply(v('lane'), u(PACK.surveyLane)))),
      step.let('st', extract(v('laneSurvey'), u(0), PACK.st)),
      step.let('aoe', extract(v('laneSurvey'), u(PACK.st), PACK.aoe)),
      step.let('shield', extract(v('laneSurvey'), u(PACK.st + PACK.aoe), PACK.shield)),
      step.let('sEff', e.subtract(v('swarmHp'), e.min(v('aoe'), v('swarmHp')))),
      step.let('bEff', e.subtract(v('bruteHp'), e.min(v('aoe'), v('bruteHp')))),
      step.let('bk', e.select(e.equal(v('bEff'), u(0)), v('brute'), e.min(v('brute'), e.divide(v('st'), e.max(v('bEff'), u(1)))))),
      step.let('rest', e.subtract(v('st'), e.multiply(v('bk'), v('bEff')))),
      step.let('sk', e.select(e.equal(v('sEff'), u(0)), v('swarm'), e.min(v('swarm'), e.divide(v('rest'), e.max(v('sEff'), u(1)))))),
      step.let('leak', e.add(e.multiply(u(C.BRUTE_LEAK), e.subtract(v('brute'), v('bk'))), e.multiply(u(C.SWARM_LEAK), e.subtract(v('swarm'), v('sk'))))),
      step.let('hit', e.subtract(v('leak'), e.min(v('leak'), v('shield')))),
      step.let('packed', e.bitOr(e.bitOr(e.bitOr(e.bitOr(
        e.cast('u128', v('swarm')), e.shiftLeft(e.cast('u128', v('brute')), u(PACK.swarm))),
        e.shiftLeft(e.cast('u128', v('sk')), u(PACK.swarm + PACK.brute))),
        e.shiftLeft(e.cast('u128', v('bk')), u(PACK.swarm * 2n + PACK.brute))),
        e.shiftLeft(e.cast('u128', v('hit')), u(PACK.swarm * 2n + PACK.brute * 2n)))),
      step.assign('totals', e.bitOr(v('totals'), e.shiftLeft(v('packed'), e.multiply(v('lane'), u(PACK.fightLane))))),
    ], { max: Number(LANES), carry: ['totals'] }),
    step.setReturnData([wide(v('totals'))]),
  ],
});

export const WAVE_TAG = Uint8Array.of(66, 68, 87, 49); // BDW1

/** Settlement and one complete wave event; owner alone commits returned values. */
export const settleTemplate = defineTemplate({
  emitEvent: true,
  inputs: inputs(['w', 'pick', 'cell', 'grid', 'walls', 'gold', 'survey', 'fight'], ['survey', 'fight']),
  accounts: {},
  steps: [
    step.let('hit', [0n, 1n, 2n, 3n].map(lane => extract(input('fight'), u(lane * PACK.fightLane + PACK.swarm * 2n + PACK.brute * 2n), PACK.hit)).reduce(e.add)),
    step.let('walls', e.subtract(input('walls'), e.min(input('walls'), v('hit')))),
    step.let('gain', extract(input('survey'), u(LANES * PACK.surveyLane), PACK.gain)),
    step.let('gold', e.add(input('gold'), v('gain'))),
    step.let('alive', e.greaterThan(v('walls'), u(0))),
    step.let('last', e.equal(input('w'), u(C.WAVES))),
    step.let('done', e.or(e.not(v('alive')), v('last'))),
    step.let('won', e.and(v('alive'), v('last'))),
    step.let('score', e.add(e.add(e.multiply(u(100), e.select(v('alive'), input('w'), e.subtract(input('w'), u(1)))), e.multiply(u(10), v('walls'))), v('gold'))),
    step.emit([
      data.literal(WAVE_TAG), enc(input('w')), enc(input('pick')), enc(input('cell')),
      enc(e.bitAnd(e.shiftRight(input('grid'), e.multiply(input('cell'), u(4))), u(15))),
      enc(v('walls')), enc(v('gold')), enc(v('gain')), enc(v('score')),
      data.encode('bool', v('done')), data.encode('bool', v('won')), wide(input('fight')),
    ]),
    step.setReturnData([wide([
      e.cast('u128', v('walls')),
      e.shiftLeft(e.cast('u128', v('gold')), u(PACK.walls)),
      e.shiftLeft(e.cast('u128', v('score')), u(PACK.walls + PACK.gold)),
    ].reduce(e.bitOr))]),
  ],
});

export const STATE_FIELDS = {
  day: 'u64', wave: 'u64', walls: 'u64', gold: 'u64', grid: 'u64', score: 'u64',
  done: 'bool', won: 'bool', bestDay: 'u64', bestScore: 'u64',
} as const;

export interface HelperAddresses { prepare: Address; survey: Address; fight: Address; settle: Address }
export type TemplateName = keyof HelperAddresses | 'state';

/** Pinned pure helpers have no registries; all persistent state belongs to this template. */
export function defineStateTemplate(addresses: HelperAddresses) {
  const reg = (field: string) => e.registry('state', field);
  const write = (field: string, value: Expression) => step.setRegistry('state', field, value);
  const call = (name: keyof HelperAddresses, values: ReturnType<typeof data.encode>[]) => step.invoke({
    program: account.fixed('ballista'),
    accounts: [{ account: account.fixed(name), signer: false, writable: false }],
    data: [data.literal(Uint8Array.of(INSTRUCTION_RUN)), ...values],
  });
  return defineTemplate({
    emitEvent: true,
    inputs: { mode: { type: 'u64' }, expectedWave: { type: 'u64' }, pick: { type: 'u64' }, cell: { type: 'u64' } },
    registries: { run: STATE_FIELDS },
    accounts: {
      player: { signer: true, writable: true },
      state: account.registry('run', { key: e.accountKey('player'), payer: 'player' }),
      systemProgram: account.systemProgram(),
      ballista: { executable: true, address: addressBytes(BALLISTA_ADDRESS) },
      ...Object.fromEntries((['prepare', 'survey', 'fight', 'settle'] as const).map(name => [name, { address: addressBytes(addresses[name]) }])),
    },
    steps: [
      step.require(e.lessThanOrEqual(input('mode'), u(1)), 'mode'),
      step.repeat(e.subtract(u(1), input('mode')), [
        write('day', e.divide(e.cast('u64', e.clockUnixTimestamp()), u(SECONDS_PER_DAY))),
        write('wave', u(0)), write('walls', u(C.WALLS_START)), write('gold', u(0)),
        write('grid', u(C.STARTING_GRID)), write('score', u(0)), write('done', e.bool(false)), write('won', e.bool(false)),
      ], { max: 1 }),
      step.repeat(input('mode'), [
        step.require(e.not(reg('done')), 'active'),
        step.require(e.equal(input('expectedWave'), reg('wave')), 'expectedWave'),
        step.require(e.lessThanOrEqual(input('pick'), u(2)), 'pick'),
        step.require(e.lessThanOrEqual(input('cell'), u(CELLS - 1n)), 'cell'),
        step.let('day', reg('day')), step.let('w', e.add(reg('wave'), u(1))),
        call('prepare', [enc(v('day')), enc(v('w')), enc(input('pick')), enc(input('cell')), enc(reg('grid'))]),
        step.let('prepared', e.returnData('u128')),
        step.let('grid', extract(v('prepared'), u(0), 64n)),
        call('survey', [enc(v('grid'))]), step.let('survey', e.returnData('u128')),
        call('fight', [enc(v('w')), enc(e.cast('u64', e.shiftRight(v('prepared'), u(64)))), wide(v('survey'))]),
        step.let('fight', e.returnData('u128')),
        call('settle', [enc(v('w')), enc(input('pick')), enc(input('cell')), enc(v('grid')), enc(reg('walls')), enc(reg('gold')), wide(v('survey')), wide(v('fight'))]),
        step.let('settled', e.returnData('u128')),
        step.let('walls', extract(v('settled'), u(0), PACK.walls)),
        step.let('gold', extract(v('settled'), u(PACK.walls), PACK.gold)),
        step.let('score', extract(v('settled'), u(PACK.walls + PACK.gold), PACK.score)),
        step.let('last', e.equal(v('w'), u(C.WAVES))),
        step.let('alive', e.greaterThan(v('walls'), u(0))),
        step.let('done', e.or(e.not(v('alive')), v('last'))),
        write('wave', v('w')), write('grid', v('grid')), write('walls', v('walls')), write('gold', v('gold')), write('score', v('score')),
        write('done', v('done')), write('won', e.and(v('alive'), v('last'))),
        // Read old bestDay before writing either best field.
        write('bestScore', e.select(v('done'), e.select(e.equal(reg('bestDay'), v('day')), e.max(reg('bestScore'), v('score')), v('score')), reg('bestScore'))),
        write('bestDay', e.select(v('done'), v('day'), reg('bestDay'))),
      ], { max: 1 }),
    ],
  });
}

export function compileTemplates(addresses: HelperAddresses) {
  return {
    prepare: compileTemplate(prepareTemplate), survey: compileTemplate(surveyTemplate),
    fight: compileTemplate(fightTemplate), settle: compileTemplate(settleTemplate),
    state: compileTemplate(defineStateTemplate(addresses)),
  };
}
