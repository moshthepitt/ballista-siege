import { compileTemplate } from '@jac0xb/ballista';
import { C, LIMITS as L, PRICE } from '../v1/constants.js';
import { rollTemplate, shopTemplate, actionTemplate, actionsTemplate } from './actions.js';
import { enemyStatsTemplate, forecastTemplate, queueTemplate } from './enemies.js';
import { boardTemplate, surveyTemplate, fireTemplate, biteTemplate, moveTemplate, laneTemplate } from './combat.js';
import { quarryTemplate, incomeTemplate, aggregateTemplate, eventTemplate, finishTemplate, prepareTemplate, boardPhaseTemplate, lanePhaseTemplate, tallyTemplate, commitTemplate, gateTemplate, ownerTemplate, type PureAddresses } from './state.js';
export const TEMPLATE_NAMES = ['roll', 'shop', 'action', 'actions', 'enemyStats', 'forecast', 'queue', 'board', 'survey', 'fire', 'bite', 'move', 'lane', 'quarry', 'income', 'aggregate', 'event', 'finish', 'prepare', 'boardPhase', 'lanePhase', 'tally', 'commit', 'gate', 'state'] as const;
export type TemplateName = typeof TEMPLATE_NAMES[number];
export type Addresses = PureAddresses & {
    state: import('@solana/kit').Address;
};
/** Compact internal fields are accepted only when every reachable v1 value fits them. */
export function checkTuning() {
    const waves = BigInt(L.WAVES), extra = waves + 1n > C.LATE_FROM ? waves + 1n - C.LATE_FROM : 0n;
    const brute = C.BRUTE_HP + waves * C.BRUTE_HP_WAVE / C.BRUTE_HP_DIV + extra * (C.LATE_BRUTE_HP_STEP + C.LATE_LEADER_HP_STEP);
    const swarm = C.SWARM_HP + waves / C.SWARM_HP_STEP;
    const count = C.SWARM_BASE + waves / C.SWARM_GROWTH_DIV + C.SWARM_SPREAD;
    const income = BigInt(L.CELLS) * (C.QUARRY_GOLD * BigInt(L.TIERS) + 4n * C.QUARRY_ADJACENT + C.QUARRY_DEEP);
    const nonBossBite = C.SWARM_BITE > C.BRUTE_BITE ? C.SWARM_BITE : C.BRUTE_BITE;
    const bossBite = [C.BOSS_BITE, C.GATEBREAKER_BITE_EVEN, C.GATEBREAKER_BITE_ODD].reduce((a, b) => a > b ? a : b);
    const bounty = C.BOSS_BOUNTY > C.BRUTE_BOUNTY ? C.BOSS_BOUNTY : C.BRUTE_BOUNTY;
    const gold = C.START_GOLD + waves * (income + C.INCOME + 4n * C.CLEAR_GOLD + 16n * 7n * bounty + 112n / C.SALVAGE_KILLS);
    if (L.LANES !== 4 || L.DEPTHS !== 4 || L.GROUPS_PER_LANE !== 4 || L.TICKS !== 10 || L.WAVES !== 10 || L.ACTIONS !== 6 || L.TIERS !== 3 || L.HP_BITS !== 8 || L.COUNT_BITS !== 4 || L.PALISADE_HP_BITS !== 6
        || 4n * C.CLEAR_GOLD > 255n || C.BALLISTA_RANGE > 7n || C.CAULDRON_RANGE > 7n || C.WATCH_RANGE > 7n || C.START_WALLS > 31n || brute > 63n || swarm > 63n || C.BOSS_5_HP > 255n || C.BOSS_10_HP > 255n || count > 7n || C.PALISADE_HP * 3n + C.OVERCLOCK_HP > 63n || C.BALLISTA_CAP > 63n || C.CAULDRON_CAP > 31n
        || 2n * count + 3n > 15n || C.BOSS_BOUNTY + 2n * C.BRUTE_BOUNTY > 15n || 3n * C.BRUTE_BOUNTY > 15n || C.SWARM_BOUNTY !== 0n
        || 2n * count * C.SWARM_LEAK + 3n * C.BRUTE_LEAK + C.BOSS_LEAK > 255n || 4n * 7n * nonBossBite > 255n || 3n * 7n * nonBossBite + bossBite > 255n || C.BRUTE_BITE > C.BOSS_BITE || C.SWARM_BITE > C.BOSS_BITE
        || C.BOSS_LEAK_BASE + C.BOSS_LEAK_HP !== C.BOSS_LEAK || C.LAST_SIEGE_BOLT_DIVISOR < 1n || C.OVERCLOCK_COST > 65535n
        || gold > 65535n || C.SCORE_WAVE * waves + C.SCORE_WALL * C.START_WALLS + C.SCORE_KILL * 112n * waves > 65535n || PRICE.some(p => p > 255n))
        throw new RangeError('Tuning exceeds Siege v1 chain packing; widen and remeasure before deployment');
}
export function defineTemplates(a: Addresses) {
    checkTuning();
    const pure = Object.fromEntries(TEMPLATE_NAMES.filter(n => n !== 'state').map(n => [n, a[n]])) as PureAddresses;
    return {
        roll: rollTemplate(), shop: shopTemplate(a.roll), action: actionTemplate(), actions: actionsTemplate(a.action, a.shop, a.roll),
        enemyStats: enemyStatsTemplate(), forecast: forecastTemplate(a.roll, a.enemyStats), queue: queueTemplate(a.forecast, a.roll, a.enemyStats),
        board: boardTemplate(), survey: surveyTemplate(), fire: fireTemplate(), bite: biteTemplate(), move: moveTemplate(), lane: laneTemplate({ fire: a.fire, bite: a.bite, move: a.move, survey: a.survey }),
        quarry: quarryTemplate(a.board), income: incomeTemplate(a.quarry, a.board), aggregate: aggregateTemplate(), event: eventTemplate(),
        finish: finishTemplate({ income: a.income, quarry: a.quarry, board: a.board, aggregate: a.aggregate }),
        prepare: prepareTemplate({ actions: a.actions, action: a.action, shop: a.shop, roll: a.roll, queue: a.queue, forecast: a.forecast, enemyStats: a.enemyStats }),
        boardPhase: boardPhaseTemplate(a.board), lanePhase: lanePhaseTemplate({ lane: a.lane, fire: a.fire, bite: a.bite, move: a.move, survey: a.survey }),
        tally: tallyTemplate(), commit: commitTemplate(a.event), gate: gateTemplate(), state: ownerTemplate(pure),
    };
}
export function compileTemplates(a: Addresses) {
    return Object.fromEntries(Object.entries(defineTemplates(a)).map(([n, t]) => [n, compileTemplate(t)])) as Record<TemplateName, ReturnType<typeof compileTemplate>>;
}
