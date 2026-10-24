import { defineTemplate } from '@jac0xb/ballista';
import type { Address } from '@solana/kit';
import { C, LIMITS as L, PART as P, RNG } from '../v1/constants.js';
import { e, step, u, w, v, inp, get, wideGet, cut, or, sum, enc, wide, inputs, accounts, call } from './vm.js';
export function enemyStatsTemplate() {
    return defineTemplate({ inputs: inputs(['y', 'wave', 'lane']), accounts: {}, steps: [
            step.let('y', inp('y')),
            step.let('heavy', e.equal(inp('lane'), get(v('y'), 40, 2))),
            step.let('boss', e.and(e.or(e.equal(inp('wave'), u(5)), e.equal(inp('wave'), u(10))), e.equal(inp('lane'), get(v('y'), 48, 2)))),
            step.let('brute', e.and(e.greaterThanOrEqual(inp('wave'), u(C.BRUTE_FROM)), e.or(v('heavy'), e.greaterThanOrEqual(inp('wave'), u(C.BRUTE_ALL_FROM))))),
            step.let('third', e.greaterThanOrEqual(inp('wave'), u(C.THIRD_GROUP_FROM))), step.let('fourth', e.greaterThanOrEqual(inp('wave'), u(C.FOURTH_GROUP_FROM))),
            step.let('length', sum(u(1), e.select(v('brute'), u(1), u(0)), e.select(v('third'), u(1), u(0)), e.select(v('fourth'), u(1), u(0)))),
            step.let('bossIndex', e.min(u(3), v('length'))),
            step.let('enabled', e.or(e.notEqual(inp('wave'), u(1)), e.or(e.equal(inp('lane'), u(0)), e.equal(inp('lane'), e.add(u(1), e.remainder(get(v('y'), 40, 2), u(3))))))),
            step.let('n', sum(u(C.SWARM_BASE), e.divide(inp('wave'), u(C.SWARM_GROWTH_DIV)), e.remainder(get(v('y'), e.multiply(inp('lane'), u(8)), 8), u(C.SWARM_SPREAD)))),
            step.let('swarmHp', e.add(u(C.SWARM_HP), e.divide(inp('wave'), u(C.SWARM_HP_STEP)))),
            step.let('bruteHp', sum(u(C.BRUTE_HP), e.divide(e.multiply(inp('wave'), u(C.BRUTE_HP_WAVE)), u(C.BRUTE_HP_DIV)), e.multiply(cut(e.add(inp('wave'), u(1)), u(C.LATE_FROM)), e.add(u(C.LATE_BRUTE_HP_STEP), e.select(v('heavy'), u(C.LATE_LEADER_HP_STEP), u(0)))))),
            step.let('bossHp', e.select(e.equal(inp('wave'), u(5)), u(C.BOSS_5_HP), u(C.BOSS_10_HP))),
            step.setReturnData([enc(or(e.shiftLeft(e.select(v('heavy'), u(1), u(0)), u(0)), e.shiftLeft(e.select(v('boss'), u(1), u(0)), u(1)), e.shiftLeft(e.select(v('brute'), u(1), u(0)), u(2)), e.shiftLeft(v('length'), u(3)), e.shiftLeft(v('bossIndex'), u(6)), e.shiftLeft(e.select(v('enabled'), u(1), u(0)), u(8)), e.shiftLeft(v('n'), u(9)), e.shiftLeft(v('swarmHp'), u(12)), e.shiftLeft(v('bruteHp'), u(18)), e.shiftLeft(v('bossHp'), u(24))))])
        ] });
}
export function forecastTemplate(roll: Address, enemyStats: Address) {
    return defineTemplate({ inputs: inputs(['seed', 'wave', 'lane']), accounts: accounts({ roll, enemyStats }), steps: [
            call('roll', [enc(inp('seed')), enc(inp('wave')), enc(u(RNG.ENEMY_SALT)), enc(u(0))]), step.let('y', e.returnData('u64')),
            call('enemyStats', [enc(v('y')), enc(inp('wave')), enc(inp('lane'))]), step.let('stats', e.returnData('u64')),
            step.let('heavy', e.notEqual(get(v('stats'), 0, 1), u(0))), step.let('boss', e.notEqual(get(v('stats'), 1, 1), u(0))), step.let('brute', e.notEqual(get(v('stats'), 2, 1), u(0))), step.let('length', get(v('stats'), 3, 3)), step.let('bossIndex', get(v('stats'), 6, 2)), step.let('enabled', e.notEqual(get(v('stats'), 8, 1), u(0))), step.let('n', get(v('stats'), 9, 3)), step.let('swarmHp', get(v('stats'), 12, 6)), step.let('bruteHp', get(v('stats'), 18, 6)), step.let('bossHp', get(v('stats'), 24, 8)),
            step.let('queue', w(0)), step.let('kinds', u(0)), step.let('spawned', u(0)),
            step.repeat(u(4), [
                step.let('i', e.loopIndex()), step.let('isBoss', e.and(v('boss'), e.equal(v('i'), v('bossIndex')))),
                step.let('isBrute', e.or(e.and(v('brute'), e.equal(v('i'), u(1))), e.equal(v('i'), u(3)))),
                step.let('kind', e.select(v('isBoss'), u(2), e.select(v('isBrute'), u(1), u(0)))),
                step.let('count', e.select(e.and(v('enabled'), e.or(e.lessThan(v('i'), v('length')), v('isBoss'))), e.select(v('isBoss'), u(1), e.select(v('isBrute'), e.add(u(1), e.select(e.and(v('heavy'), e.and(e.equal(v('i'), u(1)), e.greaterThanOrEqual(inp('wave'), u(C.HEAVY_BRUTE_FROM)))), u(1), u(0))), e.add(v('n'), e.select(e.and(v('heavy'), e.greaterThan(v('i'), u(0))), u(1), u(0))))), u(0))),
                step.let('hp', e.select(v('isBoss'), v('bossHp'), e.select(v('isBrute'), v('bruteHp'), v('swarmHp')))),
                step.let('word', or(e.shiftLeft(v('count'), u(3)), e.shiftLeft(v('hp'), u(6)), e.shiftLeft(e.select(v('isBoss'), u(0), v('hp')), u(14)))),
                step.assign('queue', e.bitOr(v('queue'), e.shiftLeft(e.cast('u128', e.select(e.equal(v('count'), u(0)), u(0), v('word'))), e.multiply(v('i'), u(20))))),
                step.assign('kinds', e.bitOr(v('kinds'), e.shiftLeft(v('kind'), e.multiply(v('i'), u(2))))), step.assign('spawned', e.add(v('spawned'), v('count'))),
            ], { max: 4, carry: ['queue', 'kinds', 'spawned'] }),
            step.setReturnData([wide(or(v('queue'), e.shiftLeft(e.cast('u128', v('kinds')), u(104)), e.shiftLeft(e.cast('u128', v('spawned')), u(116))))])
        ] });
}
export function queueTemplate(forecast: Address, roll: Address, enemyStats: Address) {
    return defineTemplate({ inputs: inputs(['seed', 'wave', 'lane', 'build'], ['build']), accounts: accounts({ forecast, roll, enemyStats }), steps: [
            call('forecast', [enc(inp('seed')), enc(inp('wave')), enc(inp('lane'))], ['ballista', 'roll', 'enemyStats']), step.let('forecast', e.returnData('u128')),
            step.let('hp', u(0)), step.repeat(u(4), [
                step.let('i', e.loopIndex()), step.let('cell', e.add(e.multiply(inp('lane'), u(4)), v('i'))),
                step.let('p', wideGet(inp('build'), e.multiply(v('cell'), u(4)), 4)), step.let('t', wideGet(inp('build'), e.add(u(64), e.multiply(v('cell'), u(2))), 2)),
                step.assign('hp', e.bitOr(v('hp'), e.shiftLeft(e.select(e.equal(v('p'), u(P.PALISADE)), e.add(e.multiply(u(C.PALISADE_HP), v('t')), e.multiply(wideGet(inp('build'), e.add(u(112), v('cell')), 1), u(C.OVERCLOCK_HP))), u(0)), e.multiply(v('i'), u(6))))),
            ], { max: 4, carry: ['hp'] }), step.setReturnData([wide(or(e.bitAnd(v('forecast'), w((1n << 80n) - 1n)), e.shiftLeft(e.cast('u128', v('hp')), u(80)), e.shiftLeft(e.cast('u128', wideGet(v('forecast'), 104, 8)), u(108)), e.shiftLeft(e.cast('u128', wideGet(v('forecast'), 116, 4)), u(124))))])
        ] });
}
