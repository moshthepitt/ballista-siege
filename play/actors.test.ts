import { afterEach, expect, it, vi } from 'vitest';
import { forecast, newRun, type EnemyGroup } from '../src/v1/sim.js';
import { renderFoes } from './ui/board.js';
import { auditLabelBoxes } from './ui/layout.js';

/** A DOM identity fixture. Geometry and label collisions remain browser-smoke checks. */
function stage({ phone = false, incoming = 0 } = {}) {
  class Node {
    dataset: Record<string, string> = {};
    style = { setProperty: vi.fn(), order: '', transform: '', gridColumn: '', gridRow: '' };
    className = ''; innerHTML = ''; title = ''; children: Node[] = []; parentElement: Node | null = null;
    classes = new Set<string>();
    classList = { toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); } };
    animate = vi.fn(); setAttribute = vi.fn();
    constructor(readonly y = 0, readonly x = 20, readonly queue = false) {}
    append(node: Node) { node.remove(); this.children.push(node); node.parentElement = this; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); this.parentElement = null; }
    chip = { animate: vi.fn(), getBoundingClientRect: () => this.getBoundingClientRect() };
    querySelector(selector: string) { return selector === '.foe' ? this.chip : null; }
    getBoundingClientRect(): DOMRect {
      const top = (this.parentElement?.y ?? this.y) + (this.parentElement?.queue ? 0 : Math.max(0, Number(this.style.gridRow) - 1) * (phone ? 9 : 13));
      const left = (this.parentElement?.x ?? this.x) + Math.max(0, Number(this.style.gridColumn.split(' / ')[0]) - 1) * 90;
      const width = phone ? this.parentElement?.queue ? 32 : 44 : 80;
      const height = phone ? 17 : 23;
      return { left, top, right: left + width, bottom: top + height, width, height } as DOMRect;
    }
  }
  const cells = Array.from({ length: 16 }, (_, i) => new Node(500 - i % 4 * 100));
  const spawn = new Node(0), wall = new Node(600);
  const entries = Array.from({ length: incoming }, (_, slot) => new Node(slot < 2 ? 30 : 0, 20 + slot % 2 * 36, true));
  if (incoming) spawn.getBoundingClientRect = () => ({ left: 20, right: 88, top: 0, bottom: 60, width: 68, height: 60 }) as DOMRect;
  const readouts: Node[] = [];
  const actors = () => [...cells, spawn, ...entries].flatMap(h => h.children);
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone && query.includes('max-width') }));
  vi.stubGlobal('document', {
    createElement: () => new Node(),
    querySelectorAll: (selector: string) => {
      if (selector === '#board .enemy-group' || selector === '#board [data-group]') return actors();
      if (selector === '#board .foes') return cells;
      if (selector.includes('.tier-tag')) return readouts;
      return [];
    },
    querySelector: (selector: string) => {
      const entry = selector.match(/data-entry-id="(\d+)"/);
      if (entry) return incoming ? entries[Number(entry[1]) % 4] : spawn;
      if (selector.includes('data-spawn')) return spawn;
      const cell = selector.match(/^\[data-cell="(\d+)"\]$/);
      if (cell) return { querySelector: () => cells[Number(cell[1])] };
      const actor = selector.match(/data-group="(\d+)"/);
      if (actor) return actors().find(n => n.dataset.group === actor[1]) ?? null;
      if (selector.includes('data-wall')) return wall;
      throw new Error(`Unexpected actor selector: ${selector}`);
    },
  });
  return { actors, cells, spawn, readouts, Node };
}
afterEach(() => vi.unstubAllGlobals());

it('moves the same keyed group, chip, bodies and crowned boss through spawn, cells and wall', () => {
  const dom = stage();
  const boss = forecast({ ...newRun(13n, 'practice'), wave: 9n }).waves[0].lanes.flat().find(g => g.kind === 'boss')!;
  const incoming: EnemyGroup = { ...boss, status: 'active', pos: 5n };
  renderFoes([incoming], null, [{ ...boss, status: 'queued' }], 240);
  const actor = dom.actors()[0];
  expect(actor.parentElement).toBe(dom.spawn);
  expect(actor.animate).not.toHaveBeenCalled(); // Activation keeps the visible queued chip still.
  expect(actor.innerHTML).toContain('unit-body boss');
  expect(actor.innerHTML).toContain('bossbar');
  expect(actor.innerHTML.match(/data-enemy-inspect=/g)).toHaveLength(2);
  const moved = { ...incoming, pos: 4n };
  renderFoes([moved], null, [incoming], 240);
  expect(dom.actors()).toEqual([actor]);
  expect(actor.parentElement).toBe(dom.cells[Number(boss.lane * 4n + 3n)]);
  expect(actor.animate).toHaveBeenCalledTimes(1);
  const keyframes = actor.animate.mock.calls[0][0];
  expect(keyframes[0].transform).toMatch(/^translate\(0px,-\d+px\)$/);
  expect(keyframes[1].transform).toBe('translate(0,0px)');
  renderFoes([{ ...moved, pos: 0n }], null, [moved], 240);
  expect(dom.actors()[0]).toBe(actor); expect(actor.classes.has('exiting')).toBe(true);
  const charges = actor.animate.mock.calls.length;
  renderFoes([{ ...moved, pos: 0n }], null, [moved], 240);
  expect(actor.animate).toHaveBeenCalledTimes(charges); // Another lane's charge must not restart this actor.
  renderFoes([{ ...moved, pos: 0n, status: 'leaked' }]);
  expect(dom.actors()).toEqual([]);
});

it.each([3, 4])('preserves queue columns on phone when %i groups depart', count => {
  const dom = stage({ phone: true, incoming: count });
  const lane = forecast({ ...newRun(4n, 'practice'), wave: 9n }).waves[0].lanes[0];
  const groups = lane.slice(0, count).map(g => ({ ...g, pos: 5n, status: 'active' as const }));
  renderFoes(groups);
  for (const group of groups) {
    const actor = dom.actors().find(n => n.dataset.group === String(group.id))!;
    const column = actor.style.gridColumn;
    renderFoes(groups.map(g => ({ ...g, pos: 4n })), null, groups, 300);
    expect(actor.style.gridColumn).toBe(column);
    expect(actor.chip.animate).toHaveBeenCalled();
  }
});

it('keeps phone cell slots for two groups plus a wave-10 boss through deaths and arrivals', () => {
  const dom = stage({ phone: true });
  const lane = forecast({ ...newRun(4n, 'practice'), wave: 9n }).waves[0].lanes.find(groups => groups.some(g => g.kind === 'boss'))!;
  const groups: EnemyGroup[] = lane.slice(1).map(g => ({ ...g, lane: 0n, pos: 4n, status: 'active' }));
  renderFoes(groups);
  const positions = dom.actors().map(n => n.getBoundingClientRect());
  expect(auditLabelBoxes(positions.map((bounds, i) => ({ name: `group ${i}`, bounds, pop: false })), {})).toEqual([]);
  renderFoes(groups.slice(1));
  expect(dom.actors().map(n => n.getBoundingClientRect())).toEqual(positions.slice(1));
  const arriving = { ...groups[0], id: 99n, order: 0n, pos: 5n };
  renderFoes([...groups.slice(1), arriving]);
  renderFoes([{ ...arriving, pos: 4n }, ...groups.slice(1)], null, [...groups.slice(1), arriving], 240);
  expect(dom.cells[3].children.slice(0, 2).map(n => n.getBoundingClientRect())).toEqual(positions.slice(1));
  expect(dom.cells[3].children.map(n => n.dataset.place)).toEqual(['2', '3', '0']);
});

it('keeps the staying actor in its cell slot when an incoming actor joins it', () => {
  const dom = stage(), base = forecast(newRun(4n, 'practice')).waves[0].lanes.flat()[0];
  const staying: EnemyGroup = { ...base, id: 1n, order: 1n, lane: 0n, pos: 4n, status: 'active' };
  const incoming: EnemyGroup = { ...staying, id: 0n, order: 0n, pos: 5n };
  renderFoes([staying, incoming]);
  const actor = dom.actors().find(a => a.dataset.group === '1')!;
  const position = actor.getBoundingClientRect();
  const moved = { ...incoming, pos: 4n };
  renderFoes([moved, staying], null, [incoming, staying], 240);
  expect(actor.dataset.place).toBe('1'); expect(actor.getBoundingClientRect()).toEqual(position);
  expect(dom.actors().find(a => a.dataset.group === '0')!.dataset.place).toBe('0');
  expect(actor.animate).not.toHaveBeenCalled();
  renderFoes([{ ...staying, status: 'dead', count: 0n }, moved]);
  expect(dom.actors()[0].dataset.place).toBe('0');
  expect(dom.actors()[0].style.gridColumn).toBe('1');
});

it('moves bodies and chip on one shared vertical path', () => {
  const dom = stage(), base = forecast(newRun(4n, 'practice')).waves[0].lanes.flat()[0];
  const group: EnemyGroup = { ...base, lane: 0n, pos: 3n, status: 'active' };
  renderFoes([group]); const actor = dom.actors()[0];
  renderFoes([{ ...group, pos: 2n }], null, [group], 300);
  expect(actor.animate.mock.calls[0][0][0].transform).toBe('translate(0px,-100px)');
  expect(actor.chip.animate).toHaveBeenCalled();
});

it('keeps killed victims until Hit finishes, and never folds a stack of four groups', () => {
  const dom = stage();
  const base = forecast(newRun(13n, 'practice')).waves[0].lanes.flat()[0];
  const groups = Array.from({ length: 4 }, (_, i): EnemyGroup => ({ ...base, id: BigInt(i), order: BigInt(i), lane: 0n, status: 'active', pos: 3n, count: 8n }));
  renderFoes(groups);
  const original = dom.actors();
  expect(original).toHaveLength(4);
  for (const actor of original) { expect(actor.innerHTML.match(/class="unit-body swarm"/g)).toHaveLength(6); expect(actor.innerHTML).toContain('>8</span>'); }
  const hit = groups.map((g, i): EnemyGroup => i === 0 ? { ...g, status: 'dead', count: 0n, hp: 0n } : g);
  renderFoes(hit, null, groups, 0, true);
  expect(dom.actors()).toEqual(original); expect(original[0].classes.has('dying')).toBe(true);
  expect(original[0].innerHTML).toContain('group-cue'); expect(original[0].innerHTML).not.toContain('unit-body');
  renderFoes(hit);
  expect(dom.actors()).toEqual(original.slice(1));
  expect(dom.actors().map(a => [a.dataset.place, a.style.gridColumn, a.style.gridRow])).toEqual([['1', '2', '4'], ['2', '1', '3'], ['3', '2', '2']]);
  expect(dom.actors().every(a => a.innerHTML.includes('formation'))).toBe(true);
});
