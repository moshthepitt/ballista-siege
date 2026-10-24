import { INSTRUCTION_RUN, defineTemplate, data, type Expression, type Step } from '@jac0xb/ballista';
import type { Address } from '@solana/kit';
import { C, LIMITS as L, PART as P } from '../v1/constants.js';
import { e, step, account, addressBytes, BALLISTA_ADDRESS, u, w, v, inp, get, wideGet, cut, or, sum, enc, wide, inputs, accounts, call } from './vm.js';
export const RUN_FIELDS = { a: 'u128', b: 'u128', c: 'u128' } as const;
export const WORK_FIELDS = { phase: 'u64', actions: 'u64', build: 'u128', board: 'u128', total: 'u128', result: 'u128', before0: 'u128', before1: 'u128', before2: 'u128', lane0: 'u128', lane1: 'u128', lane2: 'u128', lane3: 'u128' } as const;
export const WORK_OFFSETS = Object.fromEntries(Object.keys(WORK_FIELDS).map((name, i) => [name, i < 2 ? 72 + i * 8 : 88 + (i - 2) * 16]));
const ctx = { run: { owner: addressBytes(BALLISTA_ADDRESS), minDataLength: 120 }, work: { owner: addressBytes(BALLISTA_ADDRESS), minDataLength: 264 } };
const rd = (name: string) => e.accountData(account.fixed('work'), WORK_OFFSETS[name], name === 'phase' || name === 'actions' ? 'u64' : 'u128');
const run = (i: number) => e.accountData(account.fixed('run'), 72 + i * 16, 'u128');
const readLane = () => [3, 2, 1, 0].reduce((prev, i) => e.select(e.equal(v('lane'), u(i)), rd('lane' + i), prev), w(0));
export const disabled = () => or(...[0, 1, 2, 3].map(i => e.shiftLeft(wideGet(rd('lane' + i), 104, 4), u(i * 4))));
export type PureAddresses = Record<'roll' | 'shop' | 'action' | 'actions' | 'enemyStats' | 'forecast' | 'queue' | 'board' | 'survey' | 'fire' | 'bite' | 'move' | 'lane' | 'quarry' | 'aggregate' | 'event' | 'finish' | 'prepare' | 'boardPhase' | 'lanePhase' | 'tally' | 'commit' | 'gate' | 'income', Address>;
export function quarryTemplate(board: Address) {
    const match = (name: string, p: bigint): Step[] => [
        step.let(name + 'x', e.bitXor(v('parts'), u(p * 0x1111111111111111n))), step.let(name + 'a', e.bitOr(v(name + 'x'), e.shiftRight(v(name + 'x'), u(2)))), step.let(name + 'b', e.bitOr(v(name + 'a'), e.shiftRight(v(name + 'a'), u(1)))), step.let(name, e.bitAnd(e.bitXor(v(name + 'b'), u(0x1111111111111111n)), u(0x1111111111111111n)))
    ];
    return defineTemplate({ inputs: inputs(['parts', 'tiers', 'disabled']), accounts: accounts({ board }), steps: [
            call('board', [enc(inp('parts')), enc(inp('tiers')), enc(inp('disabled'))]), step.let('board', e.returnData('u128')), step.let('parts', wideGet(v('board'), 0, 64)),
            ...match('q', P.QUARRY), step.let('adj', sum(e.shiftLeft(e.bitAnd(v('q'), u(0x0111011101110111n)), u(4)), e.bitAnd(e.shiftRight(v('q'), u(4)), u(0x0111011101110111n)), e.shiftLeft(e.bitAnd(v('q'), u((1n << 48n) - 1n)), u(16)), e.shiftRight(v('q'), u(16)))),
            step.let('income', u(0)), step.repeat(u(L.CELLS), [
                step.let('i', e.loopIndex()), step.let('sh', e.multiply(v('i'), u(4))),
                step.let('isQuarry', e.notEqual(get(v('q'), v('sh'), 1), u(0))), step.let('tier', get(inp('tiers'), e.multiply(v('i'), u(2)), 2)),
                step.let('amount', sum(e.multiply(v('tier'), u(C.QUARRY_GOLD)), e.multiply(get(v('adj'), v('sh'), 3), u(C.QUARRY_ADJACENT)), e.select(e.greaterThanOrEqual(e.remainder(v('i'), u(4)), u(2)), u(C.QUARRY_DEEP), u(0)))),
                step.assign('income', e.add(v('income'), e.select(v('isQuarry'), v('amount'), u(0)))),
            ], { max: L.CELLS, carry: ['income'] }), step.setReturnData([enc(v('income'))])
        ] });
}
// Per-lane total slots: damage:8, kills:4, bounty:4, cached kinds:8, padding:8.
// Spawned stays in each lane; cumulative counters cannot carry into cached kinds.
export function aggregateTemplate() {
    return defineTemplate({ inputs: inputs(['total'], ['total']), accounts: ctx, steps: [
            ...[0, 1, 2, 3].flatMap(i => [step.let('spawn' + i, wideGet(rd('lane' + i), 124, 4)), step.let('kills' + i, wideGet(inp('total'), 32 * i + 8, 4))]),
            step.let('kills', sum(...[0, 1, 2, 3].map(i => v('kills' + i)))),
            step.let('bounty', sum(...[0, 1, 2, 3].map(i => wideGet(inp('total'), 32 * i + 12, 4)))),
            step.let('damage', sum(...[0, 1, 2, 3].map(i => wideGet(inp('total'), 32 * i, 8)))),
            step.let('clear', sum(...[0, 1, 2, 3].map(i => e.select(e.and(e.greaterThan(v('spawn' + i), u(0)), e.equal(v('spawn' + i), v('kills' + i))), u(C.CLEAR_GOLD), u(0))))),
            step.setReturnData([wide(or(e.cast('u128', v('kills')), e.shiftLeft(e.cast('u128', v('bounty')), u(8)), e.shiftLeft(e.cast('u128', v('damage')), u(16)), e.shiftLeft(e.cast('u128', v('clear')), u(32))))])
        ] });
}
export function eventTemplate() {
    const laneWord = (i: number) => or(wideGet(rd('lane' + i), 124, 4), e.shiftLeft(wideGet(v('total'), 32 * i + 8, 4), u(8)), e.shiftLeft(e.subtract(wideGet(rd('lane' + i), 124, 4), wideGet(v('total'), 32 * i + 8, 4)), u(16)), e.shiftLeft(wideGet(v('total'), 32 * i, 8), u(24)));
    return defineTemplate({ emitEvent: true, inputs: inputs(['after0', 'after1', 'after2'], ['after0', 'after1', 'after2']), accounts: ctx, steps: [
            step.let('a', rd('before0')), step.let('b', rd('before1')), step.let('c', rd('before2')), step.let('total', rd('total')),
            step.emit([data.literal(Uint8Array.of(83, 71, 86, 49)), enc(wideGet(v('a'), 0, 64)), enc(wideGet(v('b'), 65, 4)), enc(rd('actions')), wide(v('a')), wide(v('b')), wide(v('c')), wide(inp('after0')), wide(inp('after1')), wide(inp('after2')), ...[0, 1, 2, 3].map(i => enc(laneWord(i)))])
        ] });
}
export function incomeTemplate(quarry: Address, board: Address) {
    return defineTemplate({ inputs: {}, accounts: { ...accounts({ quarry, board }), ...ctx }, steps: [step.let('build', rd('build')),
            call('quarry', [enc(wideGet(v('build'), 0, 64)), enc(wideGet(v('build'), 64, 32)), enc(disabled())], ['ballista', 'board']), step.let('income', e.returnData('u64')), step.setReturnData([enc(v('income'))])] });
}
export function finishTemplate(a: Pick<PureAddresses, 'income' | 'quarry' | 'board' | 'aggregate'>) {
    return defineTemplate({ inputs: inputs(['expectedWave']), accounts: { ...accounts(a), ...ctx }, steps: [
            step.require(e.equal(rd('phase'), u(95)), 'finishPhase'), step.let('before0', run(0)), step.let('before1', run(1)), step.let('build', rd('build')),
            step.let('seed', wideGet(v('before0'), 0, 64)), step.let('meta', wideGet(v('before1'), 64, 64)), step.let('oldWave', get(v('meta'), 1, 4)), step.let('wave', e.add(v('oldWave'), u(1))),
            step.require(e.equal(inp('expectedWave'), v('oldWave')), 'expectedWave'),
            call('aggregate', [wide(rd('total'))], ['run', 'work']), step.let('totals', e.returnData('u128')),
            call('income', [], ['ballista', 'quarry', 'board', 'run', 'work']), step.let('quarry', e.returnData('u64')),
            step.let('kills', wideGet(v('totals'), 0, 8)), step.let('bounty', wideGet(v('totals'), 8, 8)), step.let('damage', wideGet(v('totals'), 16, 16)), step.let('clear', wideGet(v('totals'), 32, 8)),
            step.let('walls', cut(get(v('meta'), 5, 5), v('damage'))), step.let('totalKills', e.add(get(v('meta'), 22, 12), v('kills'))),
            step.let('gold', sum(wideGet(v('build'), 96, 16), v('bounty'), v('quarry'), u(C.INCOME), v('clear'), e.divide(v('kills'), u(C.SALVAGE_KILLS)))),
            step.let('alive', e.greaterThan(v('walls'), u(0))), step.let('last', e.equal(v('wave'), u(L.WAVES))),
            step.let('score', sum(e.multiply(e.select(v('alive'), v('wave'), e.subtract(v('wave'), u(1))), u(C.SCORE_WAVE)), e.multiply(v('walls'), u(C.SCORE_WALL)), e.multiply(v('totalKills'), u(C.SCORE_KILL)))),
            step.let('nextMeta', or(get(v('meta'), 0, 1), e.shiftLeft(v('wave'), u(1)), e.shiftLeft(v('walls'), u(5)), e.shiftLeft(e.select(e.or(e.not(v('alive')), v('last')), u(1), u(0)), u(20)), e.shiftLeft(e.select(e.and(v('alive'), v('last')), u(1), u(0)), u(21)), e.shiftLeft(v('totalKills'), u(22)))),
            step.require(e.and(e.lessThanOrEqual(v('gold'), u(65535)), e.lessThanOrEqual(v('score'), u(65535))), 'resultWidth'),
            step.setReturnData([wide(or(e.cast('u128', v('nextMeta')), e.shiftLeft(e.cast('u128', v('gold')), u(34)), e.shiftLeft(e.cast('u128', v('score')), u(50))))])
        ] });
}
export function prepareTemplate(a: Pick<PureAddresses, 'actions' | 'action' | 'shop' | 'roll' | 'queue' | 'forecast' | 'enemyStats'>) {
    return defineTemplate({ inputs: inputs(['op', 'expectedWave', 'actions', 'seed', 'mode', 'target']), accounts: { ...accounts(a), ...ctx }, steps: [
            step.let('phase', rd('phase')), step.let('a', run(0)), step.let('b', run(1)), step.let('meta', wideGet(v('b'), 64, 64)), step.let('wave', get(v('meta'), 1, 4)), step.let('timestamp', e.clockUnixTimestamp()), step.let('day', e.divide(e.cast('u64', e.max(v('timestamp'), e.i64(0))), u(86400))), step.let('patch', w(0)),
            step.repeat(e.select(e.equal(inp('op'), u(0)), u(1), u(0)), [
                step.require(e.lessThanOrEqual(inp('mode'), u(1)), 'mode'),
                step.require(e.or(e.equal(inp('mode'), u(0)), e.and(e.greaterThanOrEqual(v('timestamp'), e.i64(0)), e.equal(inp('seed'), v('day')))), 'dailySeed'),
                step.require(e.or(e.equal(inp('target'), u(0)), e.equal(inp('seed'), wideGet(v('a'), 0, 64))), 'startSeed'),
                step.assign('patch', e.select(e.equal(inp('target'), u(0)), e.cast('u128', inp('seed')), e.select(e.equal(inp('target'), u(1)), e.shiftLeft(e.cast('u128', e.bitOr(inp('mode'), u(C.START_WALLS << 5n))), u(64)), w(C.START_GOLD)))),
            ], { max: 1, carry: ['patch'] }),
            step.repeat(e.select(e.equal(inp('op'), u(1)), u(1), u(0)), [
                step.require(e.and(e.equal(v('phase'), u(0)), e.and(e.greaterThan(get(v('meta'), 5, 5), u(0)), e.equal(get(v('meta'), 20, 1), u(0)))), 'active'),
                step.require(e.equal(inp('expectedWave'), v('wave')), 'expectedWave'),
                step.require(e.or(e.equal(get(v('meta'), 0, 1), u(0)), e.and(e.greaterThanOrEqual(v('timestamp'), e.i64(0)), e.equal(wideGet(v('a'), 0, 64), v('day')))), 'dailySeed'),
                call('actions', [enc(wideGet(v('a'), 64, 64)), enc(wideGet(v('b'), 0, 32)), enc(wideGet(run(2), 0, 64)), enc(wideGet(v('a'), 0, 64)), enc(e.add(v('wave'), u(1))), enc(inp('actions')), enc(get(v('meta'), 34, 16))], ['ballista', 'action', 'shop', 'roll']), step.let('built', e.returnData('u128')), step.assign('patch', v('built')),
            ], { max: 1, carry: ['patch'] }),
            step.repeat(e.select(e.equal(inp('op'), u(2)), u(1), u(0)), [
                step.require(e.and(e.greaterThanOrEqual(v('phase'), u(1)), e.lessThanOrEqual(v('phase'), u(4))), 'initPhase'), step.require(e.equal(inp('expectedWave'), v('wave')), 'expectedWave'),
                call('queue', [enc(wideGet(v('a'), 0, 64)), enc(e.add(v('wave'), u(1))), enc(e.subtract(v('phase'), u(1))), wide(rd('build'))], ['ballista', 'forecast', 'roll', 'enemyStats']), step.let('initial', e.returnData('u128')), step.assign('patch', v('initial')),
            ], { max: 1, carry: ['patch'] }), step.setReturnData([wide(v('patch'))])
        ] });
}
export function boardPhaseTemplate(board: Address) {
    return defineTemplate({ inputs: inputs(['expectedWave']), accounts: { ...accounts({ board }), ...ctx }, steps: [
            step.let('phase', rd('phase')), step.require(e.and(e.and(e.greaterThanOrEqual(v('phase'), u(5)), e.lessThanOrEqual(v('phase'), u(86))), e.equal(e.remainder(e.subtract(v('phase'), u(5)), u(9)), u(0))), 'boardPhase'),
            step.require(e.equal(inp('expectedWave'), wideGet(run(1), 65, 4)), 'expectedWave'), step.let('build', rd('build')),
            call('board', [enc(wideGet(v('build'), 0, 64)), enc(wideGet(v('build'), 64, 32)), enc(disabled())]), step.let('result', e.returnData('u128')), step.setReturnData([wide(v('result'))])
        ] });
}
// Kinds start in the lane's otherwise unused first-tick damage byte. Tally moves
// them into the total word's padding, so later ticks avoid rebuilding forecasts.
export function lanePhaseTemplate(a: Pick<PureAddresses, 'lane' | 'fire' | 'bite' | 'move' | 'survey'>) {
    const countMask = [0n, 20n, 40n, 60n].reduce((n, sh) => n | (56n << sh), 0n);
    const retained = ((1n << 108n) - 1n) | (15n << 124n);
    return defineTemplate({ inputs: inputs(['expectedWave']), accounts: { ...accounts(a), ...ctx }, steps: [
            step.let('phase', rd('phase')), step.let('lane', e.divide(e.remainder(cut(v('phase'), u(6)), u(9)), u(2))),
            step.require(e.and(e.and(e.greaterThanOrEqual(v('phase'), u(6)), e.lessThanOrEqual(v('phase'), u(93))), e.lessThan(v('lane'), u(4))), 'fightPhase'),
            step.let('wave', wideGet(run(1), 65, 4)), step.require(e.equal(inp('expectedWave'), v('wave')), 'expectedWave'), step.let('current', readLane()), step.let('board', rd('board')),
            step.let('first', e.lessThan(v('phase'), u(14))),
            step.let('kinds', e.select(v('first'), wideGet(v('current'), 108, 8), wideGet(rd('total'), e.add(e.multiply(v('lane'), u(32)), u(16)), 8))),
            step.let('result', e.bitAnd(v('current'), w(retained))),
            step.repeat(e.select(e.notEqual(e.bitAnd(v('current'), w(countMask)), w(0)), u(1), u(0)), [
                call('lane', [enc(wideGet(v('board'), 0, 64)), enc(wideGet(v('board'), 64, 64)), enc(v('lane')), wide(e.bitAnd(v('current'), w((1n << 80n) - 1n))), enc(v('kinds')), enc(wideGet(v('current'), 80, 24)), enc(e.add(e.divide(e.subtract(v('phase'), u(6)), u(9)), u(1))), enc(e.add(v('wave'), u(1))), enc(wideGet(rd('build'), 112, 16))], ['ballista', 'fire', 'bite', 'move', 'survey']), step.let('fought', e.returnData('u128')),
                step.assign('result', e.bitOr(v('fought'), e.bitAnd(v('current'), w((15n << 104n) | (15n << 124n))))),
            ], { max: 1, carry: ['result'] }),
            step.setReturnData([wide(e.bitOr(v('result'), e.shiftLeft(e.cast('u128', e.select(v('first'), v('kinds'), u(0))), u(108))))])
        ] });
}
export const BANK = ['run.a', 'run.b', 'run.c', 'work.build', 'work.board', 'work.total', 'work.result', 'work.lane0', 'work.lane1', 'work.lane2', 'work.lane3'] as const;
export function gateTemplate() {
    const ops = 0x545454543n, targets = 0x5a5958574n;
    return defineTemplate({ inputs: inputs(['op', 'cursor', 'next', 'target', 'expectedWave', 'seed', 'mode']), accounts: ctx, steps: [
            step.let('phase', rd('phase')), step.require(e.equal(inp('cursor'), v('phase')), 'expectedCursor'),
            step.let('start', e.equal(inp('op'), u(0))), step.let('op', inp('op')), step.let('target', inp('target')), step.let('next', inp('next')),
            step.require(e.lessThanOrEqual(v('op'), u(8)), 'operation'),
            step.let('offset', e.multiply(e.remainder(cut(v('phase'), u(5)), u(9)), u(4))),
            step.let('combat', e.and(e.greaterThanOrEqual(v('phase'), u(5)), e.lessThanOrEqual(v('phase'), u(94)))),
            step.let('expectedOp', e.select(e.equal(v('phase'), u(0)), u(1), e.select(e.lessThan(v('phase'), u(5)), u(2), e.select(v('combat'), get(u(ops), v('offset'), 4), e.select(e.equal(v('phase'), u(95)), u(6), e.select(e.lessThanOrEqual(v('phase'), u(98)), u(7), u(8))))))),
            step.let('expectedTarget', e.select(e.equal(v('phase'), u(0)), u(3), e.select(e.lessThan(v('phase'), u(5)), e.add(u(6), v('phase')), e.select(v('combat'), get(u(targets), v('offset'), 4), e.select(e.and(e.greaterThanOrEqual(v('phase'), u(96)), e.lessThanOrEqual(v('phase'), u(98))), cut(v('phase'), u(96)), u(6)))))),
            step.let('validStart', e.or(e.and(e.equal(v('target'), u(0)), e.equal(v('next'), u(1001))), e.or(e.and(e.and(e.equal(v('phase'), u(1001)), e.equal(v('target'), u(1))), e.equal(v('next'), u(1002))), e.and(e.and(e.equal(v('phase'), u(1002)), e.equal(v('target'), u(2))), e.equal(v('next'), u(0)))))),
            step.require(e.select(v('start'), v('validStart'), e.and(e.lessThanOrEqual(v('phase'), u(99)), e.and(e.equal(v('op'), v('expectedOp')), e.and(e.equal(v('target'), v('expectedTarget')), e.equal(v('next'), e.select(e.equal(v('phase'), u(99)), u(0), e.add(v('phase'), u(1)))))))), 'transition'),
            step.require(e.or(v('start'), e.equal(inp('expectedWave'), e.select(e.greaterThanOrEqual(v('phase'), u(96)), wideGet(rd('before1'), 65, 4), wideGet(run(1), 65, 4)))), 'expectedWave'),
        ] });
}
export function tallyTemplate() {
    return defineTemplate({ inputs: {}, accounts: ctx, steps: [
            step.let('phase', rd('phase')), step.let('lane', e.divide(e.remainder(cut(v('phase'), u(7)), u(9)), u(2))), step.let('current', readLane()),
            step.let('summary', e.select(e.lessThan(v('phase'), u(14)), e.shiftLeft(wideGet(v('current'), 108, 8), u(16)), wideGet(v('current'), 108, 16))),
            step.setReturnData([wide(e.add(rd('total'), e.shiftLeft(e.cast('u128', v('summary')), e.multiply(v('lane'), u(32)))))])
        ] });
}
export function commitTemplate(event: Address) {
    return defineTemplate({ emitEvent: true, inputs: inputs(['op']), accounts: { ...accounts({ event }), ...ctx }, steps: [
            step.let('phase', rd('phase')), step.let('build', rd('build')), step.let('result', rd('result')),
            step.let('a', e.bitOr(e.bitAnd(rd('before0'), w((1n << 64n) - 1n)), e.shiftLeft(e.cast('u128', wideGet(v('build'), 0, 64)), u(64)))),
            step.let('b', e.bitOr(e.cast('u128', wideGet(v('build'), 64, 32)), e.shiftLeft(e.bitAnd(v('result'), w((1n << 34n) - 1n)), u(64)))),
            step.let('c', e.bitOr(e.cast('u128', wideGet(v('result'), 34, 16)), e.shiftLeft(e.cast('u128', wideGet(v('result'), 50, 16)), u(64)))),
            step.repeat(e.select(e.equal(inp('op'), u(8)), u(1), u(0)), [
                step.require(e.and(e.equal(run(0), v('a')), e.and(e.equal(run(1), v('b')), e.equal(run(2), v('c')))), 'committedState'),
                step.invoke({ program: account.fixed('ballista'), accounts: ['event', 'run', 'work'].map(name => ({ account: account.fixed(name), signer: false, writable: false })), data: [data.literal(Uint8Array.of(INSTRUCTION_RUN)), wide(v('a')), wide(v('b')), wide(v('c'))] }),
            ], { max: 1 }), step.setReturnData([wide(e.select(e.equal(inp('op'), u(8)), v('result'), e.select(e.equal(v('phase'), u(96)), v('a'), e.select(e.equal(v('phase'), u(97)), v('b'), v('c')))))])
        ] });
}
export function ownerTemplate(a: PureAddresses) {
    const reg = (field: string) => e.registry('work', field), r = (field: string) => e.registry('run', field);
    const write = (entry: string, key: string, x: Expression) => step.setRegistry(entry, key, x);
    const invoke = (target: string, forwarded: string[], values: ReturnType<typeof enc>[]) => step.invoke({ program: account.fixed('ballista'), accounts: [target, ...forwarded, 'run', 'work'].map(name => ({ account: account.fixed(name), signer: false, writable: false })), data: [data.literal(Uint8Array.of(INSTRUCTION_RUN)), ...values] });
    const steps: Step[] = [
        invoke('gate', [], ['op', 'cursor', 'next', 'target', 'expectedWave', 'seed', 'mode'].map(n => enc(inp(n)))),
        step.let('patch', w(0)),
        step.repeat(e.select(e.lessThanOrEqual(inp('op'), u(2)), u(1), u(0)), [
            invoke('prepare', ['ballista', 'actions', 'action', 'shop', 'roll', 'queue', 'forecast', 'enemyStats'], ['op', 'expectedWave', 'actions', 'seed', 'mode', 'target'].map(n => enc(inp(n)))), step.let('p', e.returnData('u128')), step.assign('patch', v('p')),
        ], { max: 1, carry: ['patch'] }),
        ...(['boardPhase', 'lanePhase', 'tally', 'finish', 'commit'] as const).map((target, j) => step.repeat(e.select(j === 4 ? e.greaterThanOrEqual(inp('op'), u(7)) : e.equal(inp('op'), u(j + 3)), u(1), u(0)), [
            invoke(target, [['ballista', 'board'], ['ballista', 'lane', 'fire', 'bite', 'move', 'survey'], [], ['ballista', 'income', 'quarry', 'board', 'aggregate'], ['ballista', 'event']][j], j === 2 ? [] : [enc(inp(j === 4 ? 'op' : 'expectedWave'))]), step.let('p' + j, e.returnData('u128')), step.assign('patch', v('p' + j)),
        ], { max: 1, carry: ['patch'] })),
        step.let('begin', e.equal(inp('op'), u(1))),
        write('work', 'total', e.select(v('begin'), w(0), reg('total'))),
        write('work', 'actions', e.select(v('begin'), inp('actions'), reg('actions'))),
        ...[0, 1, 2].map(i => write('work', 'before' + i, e.select(v('begin'), r(['a', 'b', 'c'][i]), reg('before' + i)))),
        ...BANK.map((name, i) => { const [entry, key] = name.split('.'); return write(entry, key, e.select(e.equal(inp('target'), u(i)), v('patch'), entry === 'run' ? r(key) : reg(key))); }),
        write('work', 'phase', inp('next')),
    ];
    return defineTemplate({ emitEvent: true, inputs: inputs(['op', 'cursor', 'next', 'target', 'expectedWave', 'actions', 'seed', 'mode']), registries: { game: RUN_FIELDS, combat: WORK_FIELDS }, accounts: { player: { signer: true, writable: true }, run: account.registry('game', { key: e.accountKey('player'), payer: 'player' }), work: account.registry('combat', { key: e.accountKey('player'), payer: 'player' }), systemProgram: account.systemProgram(), ...accounts(a) }, steps });
}
