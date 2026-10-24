import { defineTemplate } from '@jac0xb/ballista';
import type { Address } from '@solana/kit';
import { C, LIMITS as L, PART as P } from '../v1/constants.js';
import { e, step, u, w, v, inp, get, wideGet, cut, or, sum, enc, wide, inputs, accounts, call, builder } from './vm.js';
// Working group: pos:3, count:3, front:8, body:6. A single-unit Boss derives body from front.
// Four groups occupy 80 bits. Lane result: groups:80, palisades:24, disabled:4,
// damage:8, kills:4, bounty:4. The wrapper preserves spawned:4 in the top bits.
// The public 32-bit group codec stays in src/v1.
export const GROUP_BITS = 20;
export const SUBSETS = [0, 1, 2, 3].map(j => Array.from({ length: 16 }, (_, k) => (k & (1 << j)) ? 1n << BigInt(8 * k) : 0n).reduce((a, b) => a | b));
const kindValue = (kind: ReturnType<typeof u>, a: bigint, b: bigint, c: bigint) => e.select(e.equal(kind, u(0)), u(a), e.select(e.equal(kind, u(1)), u(b), u(c)));
export function fireTemplate() {
    const b = builder(), letv = b.let;
    const i = letv('i', e.loopIndex()), sh = letv('sh', e.multiply(i, u(GROUP_BITS)));
    const word = letv('word', wideGet(inp('queue'), sh, GROUP_BITS));
    const pos = letv('pos', get(word, 0, 3)), count = letv('count', get(word, 3, 3));
    const active = letv('active', e.greaterThan(e.multiply(pos, count), u(0)));
    const kind = letv('kind', get(inp('kinds'), e.multiply(i, u(2)), 2));
    const boss = letv('boss', e.equal(kind, u(2)));
    const mask = letv('mask', get(inp('coverage'), e.multiply(pos, u(4)), 4));
    const shoot = letv('shoot', e.select(active, e.bitAnd(mask, e.bitXor(v('fired'), u(15))), u(0)));
    b.steps.push(step.assign('fired', e.bitOr(v('fired'), shoot)));
    const d = letv('d', e.divide(wideGet(inp('damageTable'), e.multiply(shoot, u(8)), 8), e.select(boss, inp('boltDivisor'), u(1))));
    const a = letv('a', cut(e.select(active, get(inp('splash'), e.multiply(pos, u(8)), 8), u(0)), e.select(e.equal(kind, u(1)), u(C.BRUTE_SPLASH_ARMOR), u(0))));
    const hp = letv('hp', get(word, 6, 8));
    const front = letv('front', cut(hp, a));
    const body = letv('body', cut(e.select(boss, hp, get(word, 14, 6)), a));
    const spill = letv('spill', cut(d, front)), denominator = letv('den', e.max(body, u(1)));
    const boltKills = letv('boltKills', e.select(e.greaterThanOrEqual(d, front), e.add(u(1), e.divide(spill, denominator)), u(0)));
    const remaining = letv('remaining', e.select(e.equal(body, u(0)), u(0), cut(count, boltKills)));
    const nextHp = letv('nextHp', e.select(e.equal(remaining, u(0)), u(0), e.select(e.lessThan(d, front), cut(front, d), e.subtract(body, e.remainder(spill, denominator)))));
    const newWord = letv('newWord', or(pos, e.shiftLeft(remaining, u(3)), e.shiftLeft(nextHp, u(6)), e.shiftLeft(e.select(boss, u(0), body), u(14))));
    const killed = letv('killed', e.subtract(count, remaining));
    b.steps.push(step.assign('queue', e.bitOr(v('queue'), e.shiftLeft(e.cast('u128', newWord), sh))), step.assign('kills', e.add(v('kills'), killed)), step.assign('bounty', e.add(v('bounty'), e.multiply(killed, kindValue(kind, C.SWARM_BOUNTY, C.BRUTE_BOUNTY, C.BOSS_BOUNTY)))));
    return defineTemplate({ inputs: inputs(['queue', 'kinds', 'damageTable', 'coverage', 'splash', 'boltDivisor'], ['queue', 'damageTable']), accounts: {}, steps: [
            step.let('queue', w(0)), step.let('fired', u(0)), step.let('kills', u(0)), step.let('bounty', u(0)),
            step.repeat(u(L.GROUPS_PER_LANE), b.steps, { max: L.GROUPS_PER_LANE, carry: ['queue', 'fired', 'kills', 'bounty'] }),
            step.setReturnData([wide(or(v('queue'), e.shiftLeft(e.cast('u128', v('kills')), u(116)), e.shiftLeft(e.cast('u128', v('bounty')), u(120))))])
        ] });
}
export function biteTemplate() {
    const b = builder(), letv = b.let;
    const i = letv('i', e.loopIndex()), sh = letv('sh', e.multiply(i, u(GROUP_BITS)));
    const word = letv('word', wideGet(inp('queue'), sh, GROUP_BITS)), pos = letv('pos', get(word, 0, 3));
    const count = letv('count', get(word, 3, 3)), kind = letv('kind', get(inp('kinds'), e.multiply(i, u(2)), 2));
    const active = letv('active', e.greaterThan(e.multiply(pos, count), u(0)));
    // Aggregate before movement. checkTuning bounds both non-boss lanes and a
    // single Boss plus three ordinary groups below each byte's 255 limit.
    const bite = letv('bite', e.select(active, e.multiply(count, e.select(e.equal(kind, u(0)), u(C.SWARM_BITE), e.select(e.equal(kind, u(1)), u(C.BRUTE_BITE), inp('bossBite')))), u(0)));
    b.steps.push(step.assign('bites', e.add(v('bites'), e.shiftLeft(bite, e.multiply(pos, u(8))))));
    const hp = builder();
    const cell = hp.let('cell', e.loopIndex()), hs = hp.let('hs', e.multiply(cell, u(6)));
    const old = hp.let('old', get(inp('hp'), hs, 6));
    const hit = hp.let('hit', get(v('bites'), e.multiply(e.add(cell, u(2)), u(8)), 8));
    hp.steps.push(step.assign('hp', e.bitOr(v('hp'), e.shiftLeft(cut(old, hit), hs))));
    return defineTemplate({ inputs: inputs(['queue', 'kinds', 'hp', 'bossBite'], ['queue']), accounts: {}, steps: [
            step.let('bites', u(0)), step.repeat(u(4), b.steps, { max: 4, carry: ['bites'] }),
            step.let('hp', u(0)), step.repeat(u(4), hp.steps, { max: 4, carry: ['hp'] }), step.setReturnData([enc(v('hp'))])
        ] });
}
export function moveTemplate() {
    const m = builder(), mv = m.let;
    const j = mv('j', e.loopIndex()), js = mv('js', e.multiply(j, u(GROUP_BITS)));
    const g = mv('g', wideGet(inp('queue'), js, GROUP_BITS)), p = mv('p', get(g, 0, 3)), c = mv('c', get(g, 3, 3));
    const k = mv('k', get(inp('kinds'), e.multiply(j, u(2)), 2));
    const a = mv('active', e.greaterThan(e.multiply(p, c), u(0)));
    const blocked = mv('blocked', e.and(e.greaterThan(p, u(1)), e.greaterThan(get(inp('hp'), e.multiply(cut(p, u(2)), u(6)), 6), u(0))));
    const spawn = mv('spawn', e.and(e.equal(p, u(0)), e.equal(inp('tick'), e.add(j, u(1)))));
    const next = mv('next', e.select(spawn, u(5), e.select(e.and(a, e.not(blocked)), cut(p, u(1)), p)));
    const leak = mv('leak', e.and(e.greaterThan(c, u(0)), e.or(e.and(a, e.equal(next, u(0))), e.and(e.equal(inp('tick'), u(L.TICKS)), e.greaterThan(next, u(0))))));
    const nextCount = mv('nc', e.select(leak, u(0), c));
    const cellNext = mv('cellNext', cut(next, u(1)));
    const part = mv('part', get(inp('parts'), e.multiply(cellNext, u(4)), 4));
    const trample = mv('trample', e.and(e.and(a, e.not(blocked)), e.and(e.greaterThan(next, u(0)), e.and(e.notEqual(part, u(P.EMPTY)), e.notEqual(part, u(P.PALISADE))))));
    m.steps.push(step.assign('disabled', e.bitOr(v('disabled'), e.select(trample, e.shiftLeft(u(1), cellNext), u(0)))), step.assign('damage', e.add(v('damage'), e.select(leak, e.multiply(c, e.select(e.equal(k, u(0)), u(C.SWARM_LEAK), e.select(e.equal(k, u(1)), u(C.BRUTE_LEAK), e.add(u(C.BOSS_LEAK_BASE), e.divide(e.add(e.multiply(get(g, 6, 8), u(C.BOSS_LEAK_HP)), e.subtract(inp('bossHp'), u(1))), inp('bossHp')))))), u(0)))), step.assign('queue', e.bitOr(v('queue'), e.shiftLeft(e.cast('u128', or(e.bitAnd(g, u(((1n << 20n) - 1n) ^ 63n)), e.select(leak, u(0), next), e.shiftLeft(nextCount, u(3)))), js))));
    return defineTemplate({ inputs: inputs(['queue', 'kinds', 'hp', 'parts', 'tick', 'bossHp'], ['queue']), accounts: {}, steps: [
            step.let('queue', w(0)), step.let('disabled', u(0)), step.let('damage', u(0)), step.repeat(u(4), m.steps, { max: 4, carry: ['queue', 'disabled', 'damage'] }),
            step.setReturnData([wide(or(v('queue'), e.shiftLeft(e.cast('u128', inp('hp')), u(80)), e.shiftLeft(e.cast('u128', v('disabled')), u(104)), e.shiftLeft(e.cast('u128', v('damage')), u(108))))])
        ] });
}
// Convert tiers to nibble lanes, and remove disabled parts once for the tick.
export function boardTemplate() {
    return defineTemplate({ inputs: inputs(['parts', 'tiers', 'disabled']), accounts: {}, steps: [step.let('parts', u(0)), step.let('tiers', u(0)),
            step.repeat(u(16), [
                step.let('i', e.loopIndex()), step.let('sh', e.multiply(v('i'), u(4))),
                step.let('active', e.equal(get(inp('disabled'), v('i'), 1), u(0))),
                step.assign('parts', e.bitOr(v('parts'), e.shiftLeft(e.select(v('active'), get(inp('parts'), v('sh'), 4), u(0)), v('sh')))),
                step.assign('tiers', e.bitOr(v('tiers'), e.shiftLeft(get(inp('tiers'), e.multiply(v('i'), u(2)), 2), v('sh')))),
            ], { max: 16, carry: ['parts', 'tiers'] }), step.setReturnData([enc(v('parts')), enc(v('tiers'))])] });
}
function match(name: string, part: bigint) {
    const n = 0x1111111111111111n;
    return [step.let(name + 'x', e.bitXor(inp('parts'), u(n * part))),
        step.let(name + 'a', e.bitOr(v(name + 'x'), e.shiftRight(v(name + 'x'), u(2)))),
        step.let(name + 'b', e.bitOr(v(name + 'a'), e.shiftRight(v(name + 'a'), u(1)))),
        step.let(name, e.bitAnd(e.bitXor(v(name + 'b'), u(n)), u(n)))];
}
export function surveyTemplate() {
    const a = 0x0fff0fff0fff0fffn, b = 0xfff0fff0fff0fff0n;
    return defineTemplate({ inputs: inputs(['parts', 'tiers', 'lane', 'overclocked']), accounts: {}, steps: [
            ...match('forge', P.FORGE), ...match('watchBits', P.WATCHTOWER),
            step.let('forges', e.bitAnd(inp('tiers'), e.multiply(v('forge'), u(15)))),
            step.let('watches', e.bitAnd(inp('tiers'), e.multiply(v('watchBits'), u(15)))),
            step.let('adj', sum(e.shiftLeft(e.bitAnd(v('forges'), u(a)), u(4)), e.shiftRight(e.bitAnd(v('forges'), u(b)), u(4)), e.shiftLeft(e.bitAnd(v('forges'), u((1n << 48n) - 1n)), u(16)), e.shiftRight(v('forges'), u(16)))),
            step.let('towers', w(0)), step.repeat(u(4), [
                step.let('i', e.loopIndex()), step.let('cell', e.add(e.multiply(inp('lane'), u(4)), v('i'))), step.let('sh', e.multiply(v('cell'), u(4))),
                step.let('p', get(inp('parts'), v('sh'), 4)), step.let('t', get(inp('tiers'), v('sh'), 2)), step.let('f', get(v('adj'), v('sh'), 4)),
                step.let('row', e.multiply(v('i'), u(4))),
                step.let('watch', e.max(e.max(get(v('watches'), v('row'), 2), get(v('watches'), e.add(v('row'), u(16)), 2)), e.max(get(v('watches'), e.add(v('row'), u(32)), 2), get(v('watches'), e.add(v('row'), u(48)), 2)))),
                step.let('boost', get(inp('overclocked'), v('cell'), 1)),
                step.let('boltBase', e.multiply(sum(u(C.BALLISTA_DAMAGE), e.multiply(v('f'), u(C.FORGE_BALLISTA)), e.multiply(v('watch'), u(C.WATCH_DAMAGE))), v('t'))),
                step.let('splashBase', e.multiply(sum(u(C.CAULDRON_DAMAGE), e.multiply(v('f'), u(C.FORGE_CAULDRON)), e.multiply(v('watch'), u(C.WATCH_DAMAGE))), v('t'))),
                step.let('bolt', e.select(e.equal(v('p'), u(P.BALLISTA)), e.min(u(C.BALLISTA_CAP), e.add(v('boltBase'), e.multiply(v('boost'), e.divide(v('boltBase'), u(2))))), u(0))),
                step.let('splash', e.select(e.equal(v('p'), u(P.CAULDRON)), e.min(u(C.CAULDRON_CAP), e.add(v('splashBase'), e.multiply(v('boost'), e.divide(v('splashBase'), u(2))))), u(0))),
                step.let('extend', e.select(e.greaterThan(v('watch'), u(0)), u(C.WATCH_RANGE), u(0))), step.let('depth', e.add(v('i'), u(1))),
                step.let('low', cut(v('depth'), v('extend'))), step.let('high', e.min(u(5), sum(v('depth'), e.select(e.equal(v('p'), u(P.BALLISTA)), u(C.BALLISTA_RANGE), u(C.CAULDRON_RANGE)), v('extend')))),
                step.let('word', or(v('bolt'), e.shiftLeft(v('splash'), u(6)), e.shiftLeft(v('low'), u(11)), e.shiftLeft(v('high'), u(14)))),
                step.assign('towers', e.bitOr(v('towers'), e.shiftLeft(e.cast('u128', v('word')), e.multiply(v('i'), u(32))))),
            ], { max: 4, carry: ['towers'] }), step.setReturnData([wide(v('towers'))])
        ] });
}
export function laneTemplate(addresses: {
    fire: Address;
    bite: Address;
    move: Address;
    survey: Address;
}) {
    return defineTemplate({ inputs: inputs(['parts', 'tiers', 'lane', 'queue', 'kinds', 'hp', 'tick', 'wave', 'overclocked'], ['queue']), accounts: accounts(addresses), steps: [
            call('survey', [enc(inp('parts')), enc(inp('tiers')), enc(inp('lane')), enc(inp('overclocked'))]), step.let('towers', e.returnData('u128')),
            step.let('coverage', u(0)), step.let('splash', u(0)),
            step.repeat(u(4), [
                step.let('i', e.loopIndex()), step.let('t', e.shiftRight(v('towers'), e.multiply(v('i'), u(32)))),
                step.let('low', wideGet(v('t'), 11, 3)), step.let('high', wideGet(v('t'), 14, 3)),
                step.let('len', e.add(e.subtract(v('high'), v('low')), u(1))),
                step.let('bits', e.shiftLeft(e.bitAnd(e.subtract(e.shiftLeft(u(1), e.multiply(v('len'), u(4))), u(1)), u(0x111111)), e.multiply(v('low'), u(4)))),
                step.assign('coverage', e.bitOr(v('coverage'), e.shiftLeft(e.select(e.greaterThan(wideGet(v('t'), 0, 6), u(0)), v('bits'), u(0)), v('i')))),
                step.let('splashBits', e.shiftLeft(e.divide(e.subtract(e.shiftLeft(u(1), e.multiply(v('len'), u(8))), u(1)), u(255)), e.multiply(v('low'), u(8)))),
                step.assign('splash', e.add(v('splash'), e.multiply(v('splashBits'), wideGet(v('t'), 6, 5)))),
            ], { max: 4, carry: ['coverage', 'splash'] }),
            step.let('table', [0, 1, 2, 3].map(j => e.multiply(e.bitAnd(e.shiftRight(v('towers'), u(32 * j)), w(63)), w(SUBSETS[j]))).reduce(e.add)),
            call('fire', [wide(inp('queue')), enc(inp('kinds')), wide(v('table')), enc(v('coverage')), enc(v('splash')), enc(e.select(e.and(e.equal(inp('wave'), u(10)), e.equal(e.remainder(inp('tick'), u(2)), u(0))), u(C.LAST_SIEGE_BOLT_DIVISOR), u(1)))]), step.let('fired', e.returnData('u128')),
            step.let('queue', e.bitAnd(v('fired'), w((1n << 80n) - 1n))),
            call('bite', [wide(v('queue')), enc(inp('kinds')), enc(inp('hp')), enc(e.select(e.equal(inp('wave'), u(5)), e.select(e.equal(e.remainder(inp('tick'), u(2)), u(0)), u(C.GATEBREAKER_BITE_EVEN), u(C.GATEBREAKER_BITE_ODD)), u(C.BOSS_BITE)))]), step.let('hp', e.returnData('u64')),
            call('move', [wide(v('queue')), enc(inp('kinds')), enc(v('hp')), enc(get(inp('parts'), e.multiply(inp('lane'), u(16)), 16)), enc(inp('tick')), enc(e.select(e.equal(inp('wave'), u(5)), u(C.BOSS_5_HP), u(C.BOSS_10_HP)))]), step.let('moved', e.returnData('u128')),
            step.setReturnData([wide(e.bitOr(v('moved'), e.bitAnd(v('fired'), w(((1n << 8n) - 1n) << 116n))))])
        ] });
}
