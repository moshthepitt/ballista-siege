import { afterEach, describe, expect, it, vi } from 'vitest';
import { PART as P } from '../src/v1/constants.js';
import { fight, forecast, newRun, previewLanes, withPart } from '../src/v1/sim.js';
import { makeTimeline } from './replay.js';
import { renderPop } from './ui/battle.js';
import { renderVerdicts } from './ui/board.js';
import { makeBoard } from './ui/dom.js';
import { renderBanner } from './ui/hud.js';
import { battleLanes, scoreRows } from './ui/model.js';
import { renderEnd, renderSettlement } from './ui/screens.js';
import { renderShop } from './ui/shop.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

/** Capture renderer output without pretending to measure browser layout. Smoke measures that. */
function capture() {
  const nodes = new Map<string, { innerHTML: string; hidden: boolean; className: string; dataset: Record<string, string>; classList: { toggle: ReturnType<typeof vi.fn> }; setAttribute: ReturnType<typeof vi.fn>; querySelectorAll: () => [] }>();
  const node = (selector: string) => {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '', hidden: false, className: '', dataset: {}, classList: { toggle: vi.fn() }, setAttribute: vi.fn(), querySelectorAll: () => [] });
    return nodes.get(selector)!;
  };
  vi.stubGlobal('document', { querySelector: node });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  return node;
}

describe('RD2 rendered copy', () => {
  it('keeps lane-header spacing and the sixteen existing numeric cell hooks', () => {
    const node = capture(); makeBoard();
    const html = node('#board').innerHTML;
    expect(html).toContain('LANE 1</span><span class="narrow">L1');
    expect(html.match(/data-cell="\d+"/g)).toHaveLength(16);
  });
  it('shows worded verdicts, causes, and the old value beside a placement preview', () => {
    const node = capture(), lanes = previewLanes(newRun(13n, 'practice'));
    renderVerdicts(lanes, undefined, false, ['2 Swarm get through']);
    expect(node('[data-wall="0"]').innerHTML).toContain('Leaks −');
    expect(node('[data-wall="0"]').innerHTML).toContain('class="why">2 Swarm get through');
    renderVerdicts(lanes, lanes.map(l => ({ ...l, leaks: 0n })));
    expect(node('[data-wall="0"]').innerHTML).toContain('class="was">−');
    expect(node('[data-wall="0"]').innerHTML).toContain('Holds</span>');
    expect(node('[data-wall="0"]').innerHTML).toContain('if you place it');
    renderVerdicts(lanes.map(l => ({ ...l, leaks: 0n })), undefined, true, ['3 kills']);
    expect(node('[data-wall="0"]').innerHTML).toContain('Cleared</span>');
    expect(node('[data-wall="0"]').innerHTML).toContain('3 kills');
  });
  it('shows Boss coming, Holding and Cleared from current battle groups', () => {
    const node = capture(), state = { ...newRun(13n, 'practice'), wave: 4n };
    const groups = forecast(state).waves[0].lanes.flat(), boss = groups.find(g => g.kind === 'boss')!;
    const lanes = battleLanes(state, null);
    renderVerdicts(lanes, undefined, false, [], groups);
    expect(node(`[data-wall="${boss.lane}"]`).innerHTML).toContain('Boss coming');
    renderVerdicts(lanes, undefined, false, [], groups.map(g => ({ ...g, status: 'active' })));
    expect(node(`[data-wall="${boss.lane}"]`).innerHTML).toContain('Boss in lane');
    const normal = groups.filter(g => g.kind !== 'boss').map(g => ({ ...g, status: 'active' as const }));
    renderVerdicts(lanes, undefined, false, [], normal);
    expect(node(`[data-wall="${boss.lane}"]`).innerHTML).toContain('Holding');
    renderVerdicts(lanes, undefined, false, [], groups.map(g => ({ ...g, status: 'dead', count: 0n })));
    expect(node(`[data-wall="${boss.lane}"]`).innerHTML).toContain('Boss down +8g');
  });
  it('renders uppercase phase tags and compact cards with only their short effect', () => {
    const node = capture(), state = newRun(13n, 'practice');
    renderBanner('build', state, 0n, 0n);
    expect(node('#phase-banner').innerHTML).toContain('>BUILD</span>');
    renderBanner('summary', { ...state, wave: 5n }, 10n, 0n);
    expect(node('#phase-banner').innerHTML).toContain('>WAVE 5 DONE</span>');
    renderShop(state, null, true, false);
    expect(node('#shop').innerHTML).toContain('Shoots lane · 4 dmg');
    expect(node('#shop').innerHTML).toContain('Lane splash · 1/unit');
    expect(node('#shop').innerHTML).not.toContain('Overkill carries');
    expect(node('#shop').innerHTML.match(/class="eff"/g)).toHaveLength(4);
  });
  it('omits zero receipt rows while retaining Base and the exact payout', () => {
    const node = capture(), built = newRun(4n, 'practice'), result = fight(built);
    renderSettlement({ start: built, built, result, timeline: makeTimeline(built, result.frames) });
    const html = node('#settlement').innerHTML;
    expect(html).toContain('<span>Base</span><b>+5</b>');
    expect(html).not.toContain('<b>+0</b>');
    expect(html).toContain('Base +5 · Total +5g');
    expect(html).not.toContain('<svg');
  });
  it.each([false, true])('renders a complete %s win result with count × weight and points', won => {
    const node = capture();
    let built = { ...newRun(13n, 'practice'), wave: 9n };
    if (won) for (let lane = 0n; lane < 4n; lane++) {
      built = withPart(built, lane * 4n, P.BALLISTA, 3n);
      built = withPart(built, lane * 4n + 1n, P.FORGE, 3n);
      built = withPart(built, lane * 4n + 2n, P.BALLISTA, 3n);
      built = withPart(built, lane * 4n + 3n, P.PALISADE, 3n);
    }
    const result = fight(built), state = result.state;
    expect(state.done).toBe(true); expect(state.won).toBe(won);
    for (const phoneView of [false, true]) {
      vi.stubGlobal('matchMedia', () => ({ matches: phoneView }));
      renderEnd(state, [{ start: built, built, result, timeline: makeTimeline(built, result.frames) }], 0, { score: state.score, wave: state.wave, won, current: true }, false, false);
      const html = node('#end-screen').innerHTML;
      expect(html).toContain(won ? 'RUN WON' : 'RUN LOST');
      for (const row of scoreRows(state)) {
        expect(html).toContain(`${row.count} × ${row.weight}`);
        expect(html).toContain(`${row.points} pts`);
      }
      expect(html).toContain('data-command="replan-wave"');
      expect(html).toContain('data-command="new-seed"');
      expect(html.match(/data-command="full-report"/g)).toHaveLength(1);
      expect(html.includes('phone-report')).toBe(phoneView);
    }
  });
});

it('renders pops in captured columns despite a single surviving chip, replacing and expiring them', () => {
  vi.useFakeTimers();
  type Span = { dataset: Record<string, string>; style: Record<string, unknown>; addEventListener: ReturnType<typeof vi.fn>; remove: () => void };
  const children: Span[] = [];
  const band = {
    append: (node: Span) => children.push(node),
    querySelector: (selector: string) => children.find(n => selector === `[data-pop-slot="${n.dataset.popSlot}"]`),
  };
  const cell = { querySelector: () => band, querySelectorAll: () => [{}] };
  vi.stubGlobal('document', {
    querySelector: () => cell,
    createElement: () => {
      const node: Span = { dataset: {}, style: { setProperty: vi.fn() }, addEventListener: vi.fn(), remove: () => { const i = children.indexOf(node); if (i >= 0) children.splice(i, 1); } };
      return node;
    },
  });
  renderPop({ key: 'swarm', cell: 14n, slot: 0, column: '1', text: '−3', kind: 'splash' }, 1);
  renderPop({ key: 'brute', cell: 14n, slot: 1, column: '2', text: '−1', kind: 'splash' }, 1);
  expect(children.map(n => [n.dataset.popSlot, n.style.gridColumn, n.style.gridRow])).toEqual([['0', '1', '1'], ['1', '2', '1']]);
  renderPop({ key: 'bite', cell: 14n, slot: 1, column: '2', text: '−3', kind: 'bite' }, 2);
  expect(children).toHaveLength(2);
  const [event, cleanup, options] = children[0].addEventListener.mock.calls[0];
  expect(event).toBe('animationend'); expect(options).toEqual({ once: true });
  cleanup(); expect(children).toHaveLength(1);
  vi.advanceTimersByTime(400); expect(children).toHaveLength(0);
  vi.runAllTimers();
});
