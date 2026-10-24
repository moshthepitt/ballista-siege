import { PART as P } from '../../src/v1/constants.js';
import { partAt, type RunState } from '../../src/v1/sim.js';
import { laneCauses, type Cause } from '../insights.js';
import { statsAt, isWeapon } from '../parts.js';
import { wallLosses, type ReplayStep } from '../replay.js';

const phaseOrder: Record<Cause['phase'], number> = { Fire: 0, Bite: 1, Move: 2, Storm: 3, Result: 4 };
export const causeOrder = (a: Cause, b: Cause) => Number(a.tick - b.tick) || phaseOrder[a.phase] - phaseOrder[b.phase];
const enemyName = (g?: ReplayStep['before'][number]) => g?.kind === 'boss' ? g.bossPattern === 'gatebreaker' ? 'Gatebreaker' : 'Last Siege' : g?.kind === 'brute' ? 'Brute' : 'Swarm';

/** Keep actual wall losses and events which opened their path or silenced covering guns. */
export function lossReport(built: RunState, timeline: readonly ReplayStep[]): Cause[] {
  const out: Cause[] = [];
  for (const loss of wallLosses(built, timeline).filter(l => l.wallsLost > 0n)) {
    const leakStep = timeline.find(s => s.frame.leaks.some(l => l.group === loss.group))!;
    const causes = laneCauses(built, timeline, loss.lane, loss.group);
    out.push(...causes.filter(c => c.kind === 'hit' && !c.text.startsWith('No damaging')));
    for (const step of timeline) {
      if (step.frame.tick > leakStep.frame.tick) break;
      for (const p of step.frame.palisades) {
        if (p.hp || p.cell / 4n !== loss.lane) continue;
        const bites = step.frame.bites.filter(b => b.cell === p.cell && b.damage);
        if (!bites.length) continue;
        const priorHp = timeline[Number(step.frame.tick) - 2]?.frame.palisades.find(v => v.cell === p.cell)?.hp ?? statsAt(built, p.cell).hp;
        if (!priorHp) continue;
        // A deadline charge does not need a broken fence it never crossed normally.
        const crossed = timeline.some(s => s.frame.tick >= step.frame.tick && s.frame.tick <= leakStep.frame.tick && s.before.some(g => g.id === loss.group && g.status === 'active' && g.pos > p.cell % 4n + 1n) && s.frame.groups.some(g => g.id === loss.group && g.pos === p.cell % 4n + 1n));
        if (!crossed) continue;
        const names = [...new Set(bites.map(b => enemyName(step.before.find(g => g.id === b.group))))].join(' + ');
        out.push({ tick: step.frame.tick, phase: 'Bite', kind: 'break', group: loss.group, text: `${names} broke the L${loss.lane + 1n} fence on tick ${step.frame.tick} (D${p.cell % 4n + 1n})` });
      }
      for (const trample of step.frame.tramples) {
        const activeGuns = Array.from({ length: 16 }, (_, i) => BigInt(i)).filter(cell => cell / 4n === loss.lane && isWeapon(partAt(built, cell)));
        const previous = timeline[Number(step.frame.tick) - 2]?.frame.disabled ?? 0n;
        const covering = activeGuns.some(cell => {
          if (previous & (1n << cell)) return false;
          const before = statsAt(built, cell, previous), after = statsAt(built, cell, previous | 1n << trample.cell);
          if (cell !== trample.cell && before.value === after.value && before.low === after.low && before.high === after.high) return false;
          return timeline.some(s => s.frame.tick > step.frame.tick && s.frame.tick <= leakStep.frame.tick && s.before.some(g => g.id === loss.group && g.status === 'active' && Number(g.pos) >= before.low && Number(g.pos) <= before.high));
        });
        if (!covering || partAt(built, trample.cell) === P.QUARRY) continue;
        const cause = causes.find(c => c.kind === 'trample' && c.tick === step.frame.tick && c.text.includes(`L${trample.cell / 4n + 1n} D${trample.cell % 4n + 1n}`));
        if (cause) out.push(cause);
      }
    }
    out.push({ tick: leakStep.frame.tick, phase: loss.storm ? 'Storm' : 'Move', kind: 'leak', group: loss.group,
      text: `L${loss.lane + 1n} ${loss.name} ${loss.storm ? 'stormed the wall, bypassing Palisades' : 'reached the wall'} · ${loss.hp} HP survived · −${loss.wallsLost} walls${loss.damage !== loss.wallsLost ? ` (${loss.damage} requested)` : ''}` });
  }
  const seen = new Set<string>();
  return out.sort(causeOrder).filter(c => { const key = `${c.tick}:${c.phase}:${c.text}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
export function costliestCause(built: RunState, timeline: readonly ReplayStep[]): string {
  const losses = wallLosses(built, timeline).filter(l => l.wallsLost > 0n).sort((a, b) => Number(b.wallsLost - a.wallsLost));
  const loss = losses[0]; if (!loss) return 'All lanes held.';
  const causes = lossReport(built, timeline);
  const breach = causes.find(c => c.group === loss.group && c.kind === 'break');
  return breach ? `${breach.text}, ${loss.name} leaked −${loss.wallsLost}.` : `${loss.name} ${loss.storm ? 'stormed' : 'reached'} the L${loss.lane + 1n} wall; −${loss.wallsLost}.`;
}
