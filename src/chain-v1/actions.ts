import { defineTemplate } from '@jac0xb/ballista';
import type { Address } from '@solana/kit';
import { C, LIMITS as L, PART as P, PRICE, RNG } from '../v1/constants.js';
import { e, step, u, w, v, inp, get, wideGet, cut, or, sum, enc, wide, inputs, accounts, call, xor, mask } from './vm.js';
// Final build layout. Inside actionsTemplate only, bits 112..118 hold shop
// counters while the boost mask has its own loop-carried register.
export const BUILD = { parts: 0, tiers: 64, gold: 96, overclocked: 112 } as const;
export function rollSteps(name: string, seed: ReturnType<typeof u>, wave: ReturnType<typeof u>, salt: bigint, rerolls = u(0)) {
    return [step.let(name + 'mix', e.bitXor(e.bitXor(seed, u(RNG.BASE)), sum(e.multiply(wave, u(RNG.WAVE)), u(salt), e.multiply(rerolls, u(RNG.REROLL))))), ...xor(name + 'one', v(name + 'mix')), ...xor(name, v(name + 'one'))];
}
export function rollTemplate() {
    return defineTemplate({ inputs: inputs(['seed', 'wave', 'salt', 'rerolls']), accounts: {}, steps: [
            step.let('mix', e.bitXor(e.bitXor(inp('seed'), u(RNG.BASE)), sum(e.multiply(inp('wave'), u(RNG.WAVE)), inp('salt'), e.multiply(inp('rerolls'), u(RNG.REROLL))))),
            ...xor('one', v('mix')), ...xor('result', v('one')), step.setReturnData([enc(v('result'))])
        ] });
}
export function shopTemplate(roll: Address) {
    const pack = (ns: number[]) => ns.reduce((n, x, i) => n | BigInt(x) << BigInt(4 * i), 0n);
    return defineTemplate({ inputs: inputs(['seed', 'wave', 'rerolls', 'command']), accounts: accounts({ roll }), steps: [
            step.let('op', get(inp('command'), 0, 3)), step.let('cell', get(inp('command'), 3, 4)), step.let('slot', get(inp('command'), 7, 2)),
                step.require(e.and(e.greaterThanOrEqual(v('op'), u(1)), e.lessThanOrEqual(v('op'), u(5))), 'opcode'),
                step.require(e.or(e.equal(v('op'), u(1)), e.equal(v('slot'), u(0))), 'slotPadding'),
                step.require(e.or(e.notEqual(v('op'), u(4)), e.equal(v('cell'), u(0))), 'cellPadding'),
            call('roll', [enc(inp('seed')), enc(inp('wave')), enc(u(RNG.SHOP_SALT)), enc(u(0))]), step.let('base', e.returnData('u64')),
            step.let('weapon', e.add(u(1), e.bitXor(get(v('base'), 0, 1), get(inp('rerolls'), 0, 1)))),
            call('roll', [enc(inp('seed')), enc(inp('wave')), enc(u(RNG.SHOP_SALT)), enc(inp('rerolls'))]), step.let('roll', e.returnData('u64')),
            step.let('x', v('roll')), step.let('deck', e.select(e.equal(v('weapon'), u(P.BALLISTA)), u(pack([2, 3, 4, 5, 6])), u(pack([1, 3, 4, 5, 6])))),
            step.repeat(u(4), [
                step.let('k', e.subtract(u(4), e.loopIndex())), ...xor('next', v('x')), step.assign('x', v('next')),
                step.let('j', e.remainder(v('x'), e.add(v('k'), u(1)))), step.let('ks', e.multiply(v('k'), u(4))), step.let('js', e.multiply(v('j'), u(4))),
                step.let('swap', e.bitXor(get(v('deck'), v('ks'), 4), get(v('deck'), v('js'), 4))),
                step.assign('deck', e.bitXor(e.bitXor(v('deck'), e.shiftLeft(v('swap'), v('ks'))), e.shiftLeft(v('swap'), v('js')))),
            ], { max: 4, carry: ['x', 'deck'] }),
            step.let('support', [4, 3, 2, 1, 0].reduce((prev, j) => e.select(e.greaterThanOrEqual(get(v('deck'), j * 4, 4), u(P.FORGE)), get(v('deck'), j * 4, 4), prev), u(P.FORGE))),
            step.let('opening', e.and(e.equal(inp('wave'), u(1)), e.equal(inp('rerolls'), u(0)))),
            step.let('tail', e.select(v('opening'), or(e.subtract(u(3), v('weapon')), e.shiftLeft(u(P.PALISADE), u(4)), e.shiftLeft(v('support'), u(8))), get(v('deck'), 0, 12))),
            step.setReturnData([enc(e.bitOr(v('weapon'), e.shiftLeft(v('tail'), u(4))))])
        ] });
}
export function actionTemplate() {
    const priceTable = PRICE.reduce<bigint>((n, p, i) => n | p << BigInt(i * 8), 0n);
    return defineTemplate({ inputs: inputs(['build', 'command', 'shop', 'overclocked'], ['build']), accounts: {}, steps: [
            step.let('parts', wideGet(inp('build'), 0, 64)), step.let('tiers', wideGet(inp('build'), 64, 32)), step.let('gold', wideGet(inp('build'), 96, 16)),
            step.let('rerolls', wideGet(inp('build'), 112, 3)), step.let('bought', wideGet(inp('build'), 115, 4)),
            step.let('op', get(inp('command'), 0, 3)), step.let('cell', get(inp('command'), 3, 4)), step.let('slot', get(inp('command'), 7, 2)),
            step.let('ps', e.multiply(v('cell'), u(4))), step.let('ts', e.multiply(v('cell'), u(2))),
            step.let('p', get(v('parts'), v('ps'), 4)), step.let('t', get(v('tiers'), v('ts'), 2)), step.let('offer', get(inp('shop'), e.multiply(v('slot'), u(4)), 4)),
            step.let('buy', e.equal(v('op'), u(1))), step.let('upgrade', e.equal(v('op'), u(2))), step.let('sell', e.equal(v('op'), u(3))), step.let('reroll', e.equal(v('op'), u(4))), step.let('overclock', e.equal(v('op'), u(5))),
            step.require(e.select(v('buy'), e.and(e.equal(v('p'), u(0)), e.equal(get(v('bought'), v('slot'), 1), u(0))), e.bool(true)), 'buy'),
            step.require(e.or(e.not(e.or(v('upgrade'), v('sell'))), e.greaterThan(v('p'), u(0))), 'occupied'),
            step.require(e.or(e.not(v('upgrade')), e.lessThan(v('t'), u(L.TIERS))), 'tier'),
            step.require(e.or(e.not(v('overclock')), e.and(e.and(e.equal(v('t'), u(3)), e.lessThanOrEqual(v('p'), u(P.PALISADE))), e.equal(get(inp('overclocked'), v('cell'), 1), u(0)))), 'overclock'),
            step.let('price', get(u(priceTable), e.multiply(e.select(v('buy'), v('offer'), v('p')), u(8)), 8)),
            step.let('upper', e.divide(e.multiply(v('price'), u(C.UPGRADE_3_NUM)), u(C.UPGRADE_3_DEN))),
            step.let('paid', e.add(e.multiply(v('price'), e.min(v('t'), u(2))), e.select(e.equal(v('t'), u(3)), v('upper'), u(0)))),
            step.let('refund', e.select(v('sell'), e.divide(v('paid'), u(2)), u(0))),
            step.let('cost', e.select(v('buy'), v('price'), e.select(v('upgrade'), e.select(e.equal(v('t'), u(1)), v('price'), v('upper')), e.select(v('reroll'), e.add(v('rerolls'), u(1)), e.select(v('overclock'), u(C.OVERCLOCK_COST), u(0)))))),
            step.let('available', e.add(v('gold'), v('refund'))), step.require(e.lessThanOrEqual(v('cost'), v('available')), 'gold'),
            step.let('goldNext', e.subtract(v('available'), v('cost'))), step.require(e.lessThanOrEqual(v('goldNext'), u(65535)), 'goldWidth'),
            step.let('np', e.select(v('buy'), v('offer'), e.select(v('sell'), u(0), v('p')))), step.let('nt', e.select(v('buy'), u(1), e.select(v('sell'), u(0), e.select(v('upgrade'), e.add(v('t'), u(1)), v('t'))))),
            step.setReturnData([enc(or(v('goldNext'), e.shiftLeft(e.bitXor(v('p'), v('np')), u(16)), e.shiftLeft(e.bitXor(v('t'), v('nt')), u(20))))])
        ] });
}
export function actionsTemplate(action: Address, shop: Address, roll: Address) {
    return defineTemplate({ inputs: inputs(['parts', 'tiers', 'gold', 'seed', 'wave', 'actions', 'overclocked']), accounts: accounts({ action, shop, roll }), steps: [
            step.let('n', get(inp('actions'), 0, 3)), step.require(e.lessThanOrEqual(v('n'), u(L.ACTIONS)), 'actionCount'),
            step.require(e.equal(e.shiftRight(inp('actions'), e.add(u(3), e.multiply(v('n'), u(9)))), u(0)), 'actionPadding'),
            step.require(e.lessThanOrEqual(inp('gold'), u(65535)), 'goldWidth'),
            step.let('overclocked', inp('overclocked')),
            step.let('build', or(e.cast('u128', inp('parts')), e.shiftLeft(e.cast('u128', inp('tiers')), u(64)), e.shiftLeft(e.cast('u128', inp('gold')), u(96)))),
            step.repeat(v('n'), [
                step.let('command', get(inp('actions'), e.add(u(3), e.multiply(e.loopIndex(), u(9))), 9)),
                step.let('op', get(v('command'), 0, 3)), step.let('cell', get(v('command'), 3, 4)), step.let('slot', get(v('command'), 7, 2)),
                call('shop', [enc(inp('seed')), enc(inp('wave')), enc(wideGet(v('build'), 112, 3)), enc(v('command'))], ['ballista', 'roll']), step.let('offers', e.returnData('u64')),
                call('action', [wide(v('build')), enc(v('command')), enc(v('offers')), enc(v('overclocked'))]), step.let('next', e.returnData('u64')),
                step.let('bit', e.shiftLeft(u(1), v('cell'))),
                step.assign('overclocked', e.bitOr(e.bitAnd(v('overclocked'), e.bitXor(e.select(e.equal(v('op'), u(3)), v('bit'), u(0)), u(65535))), e.select(e.equal(v('op'), u(5)), v('bit'), u(0)))),
                step.let('ps', e.multiply(v('cell'), u(4))), step.let('ts', e.add(u(64), e.multiply(v('cell'), u(2)))),
                step.let('partDelta', get(v('next'), 16, 4)), step.let('tierDelta', get(v('next'), 20, 2)),
                step.let('board', e.bitAnd(e.bitXor(e.bitXor(v('build'), e.shiftLeft(e.cast('u128', v('partDelta')), v('ps'))), e.shiftLeft(e.cast('u128', v('tierDelta')), v('ts'))), w(mask(96)))),
                step.let('reroll', e.equal(v('op'), u(4))), step.let('r', e.add(wideGet(v('build'), 112, 3), e.select(v('reroll'), u(1), u(0)))),
                step.let('b', e.select(v('reroll'), u(0), e.bitOr(wideGet(v('build'), 115, 4), e.select(e.equal(v('op'), u(1)), e.shiftLeft(u(1), v('slot')), u(0))))),
                step.assign('build', or(v('board'), e.shiftLeft(e.cast('u128', get(v('next'), 0, 16)), u(96)), e.shiftLeft(e.cast('u128', v('r')), u(112)), e.shiftLeft(e.cast('u128', v('b')), u(115)))),
            ], { max: L.ACTIONS, carry: ['build', 'overclocked'] }), step.setReturnData([wide(e.bitOr(e.bitAnd(v('build'), w(mask(112))), e.shiftLeft(e.cast('u128', v('overclocked')), u(112))))])
        ] });
}
