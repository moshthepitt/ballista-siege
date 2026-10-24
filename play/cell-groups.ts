import type { EnemyGroup } from '../src/v1/sim.js';

/** Retain occupants' slots; arrivals take the first vacancy in arrival order. */
export function cellSlots(groups: readonly Pick<EnemyGroup, 'id' | 'order'>[], prior: ReadonlyMap<bigint, number> = new Map()): Map<bigint, number> {
  const slots = new Map<bigint, number>();
  for (const g of groups) if (prior.has(g.id)) slots.set(g.id, prior.get(g.id)!);
  for (const g of [...groups].sort((a, b) => Number(a.order - b.order))) {
    if (slots.has(g.id)) continue;
    let slot = 0; while ([...slots.values()].includes(slot)) slot++;
    slots.set(g.id, slot);
  }
  return slots;
}
export interface GroupBox { left: number; top: number; width: number; height: number }
export interface CellGroupLayout { slot: number; compact?: boolean; tight?: boolean; body: GroupBox; label: GroupBox; cue: GroupBox; bar: GroupBox }
export const enemyBodySize = (kind: EnemyGroup['kind'], viewportWidth: number, viewportHeight: number): number => {
  const floor = { swarm: 12, brute: 18, boss: 28 }[kind];
  return viewportWidth < 1024 ? Math.max(floor, Math.round(floor * Math.min(viewportWidth / 390, viewportHeight / 844))) : Math.max(floor, Math.round({ swarm: 28, brute: 44, boss: 64 }[kind] * Math.min(1, viewportWidth / 1920, viewportHeight / 950)));
};
export interface BodySpec { kind: EnemyGroup['kind']; count: number; size: number }
/** Stable body sizes; only formation count and the reserved bands change with crowding. */
export function cellGroupLayout(width: number, height: number, slots: ReadonlyMap<bigint, number>, partHeight = 0, tagHeight = 0, bosses: ReadonlySet<bigint> = new Set(), specs?: ReadonlyMap<bigint, BodySpec>): Map<bigint, CellGroupLayout> {
  const out = new Map<bigint, CellGroupLayout>();
  if (!slots.size) return out;
  let inset = 2, gap = 1, top = tagHeight + 2;
  const usable = height - top - partHeight - 2;
  const entries = [...slots].sort((a, b) => a[1] - b[1]);
  const spec = (id: bigint): BodySpec => specs?.get(id) ?? { kind: bosses.has(id) ? 'boss' : 'swarm', count: 1, size: Math.min(12, Math.max(1, usable / 2 - 4)) };
  type Tile = { id: bigint; slot: number; width: number; height: number; bodyWidth: number; bodyHeight: number; labelWidth: number; above: boolean; compact: boolean };
  const tiles: Tile[] = entries.map(([id, slot]) => {
    const s = spec(id), count = Math.min(6, s.count);
    let labelWidth = slots.size === 1 ? Math.min(58, width - s.size - 6) : s.kind === 'boss' ? 24 : width < 120 ? 14 : 20;
    labelWidth = Math.max(14, labelWidth);
    let bodyWidth = s.size, bodyHeight = s.size, compact = slots.size > 1 || labelWidth < 40;
    if (!compact) for (let cols = 1; cols <= count; cols++) {
      const rows = Math.ceil(count / cols);
      if (cols * s.size + labelWidth + 2 <= width - 4 && rows * s.size + 4 <= usable) { bodyWidth = cols * s.size; bodyHeight = rows * s.size; break; }
    }
    if (bodyWidth * bodyHeight < count * s.size * s.size) compact = true;
    const above = slots.size > 1 && s.kind === 'boss' && width < 120;
    return { id, slot, width: above ? Math.max(bodyWidth, labelWidth) : bodyWidth + labelWidth + 2, height: Math.max(14, bodyHeight + 4 + (above ? 14 : 0)), bodyWidth, bodyHeight, labelWidth, above, compact };
  });
  const overlaps = (a: GroupBox, b: GroupBox) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;
  // At most four rectangles: try edge placements, largest first. A boss can
  // occupy both ordinary tracks while smaller groups use the remaining space.
  const ordered = [...tiles].sort((a,b) => b.height - a.height || a.slot - b.slot);
  const placed = new Map<bigint, GroupBox>();
  const pack = (index: number): boolean => {
    if (index === ordered.length) return true;
    const tile = ordered[index], boxes = [...placed.values()];
    const xs = [inset, ...boxes.map(b => b.left + b.width + gap)], ys = [top, ...boxes.map(b => b.top + b.height)];
    for (const y of ys.sort((a,b) => a-b)) for (const x of xs.sort((a,b) => a-b)) {
      const box = { left: x, top: y, width: tile.width, height: tile.height };
      if (x + tile.width > width - 1 || y + tile.height > height - partHeight - 1 || boxes.some(b => overlaps(box,b))) continue;
      placed.set(tile.id, box); if (pack(index + 1)) return true; placed.delete(tile.id);
    }
    return false;
  };
  let tight = false;
  if (!pack(0)) {
    // Short laptop rows can fit all four bodies across. Use the compact HP
    // digits' measured widths and tighter gutters, never smaller bodies.
    tight = true; inset = 1; gap = 0; top = tagHeight + 1;
    for (const tile of tiles) {
      const s = spec(tile.id);
      tile.bodyWidth = s.size; tile.bodyHeight = s.size; tile.compact = true;
      tile.labelWidth = s.kind === 'boss' ? 24 : s.kind === 'brute' ? 14 : 10;
      tile.width = tile.above ? Math.max(s.size, tile.labelWidth) : s.size + tile.labelWidth + 2;
      tile.height = Math.max(14, s.size + 4 + (tile.above ? 14 : 0));
    }
    placed.clear(); pack(0);
  }
  for (const tile of tiles) {
    const box = placed.get(tile.id) ?? { left: 2 + tile.slot % 2 * (width - 4) / 2, top: top + Math.floor(tile.slot / 2) * usable / 2, width: tile.width, height: tile.height };
    // A solitary formation uses the open middle; crowds keep their packed slots.
    const dx = slots.size === 1 ? Math.max(0, (width - 4 - box.width) / 2) : 0;
    const dy = slots.size === 1 ? Math.max(0, (usable - box.height) / 2) : 0;
    const body = { left: box.left + dx + (tile.above ? (tile.width - tile.bodyWidth) / 2 : 0), top: box.top + dy + (tile.above ? 14 : 0), width: tile.bodyWidth, height: tile.bodyHeight + 4 };
    const label = { left: tile.above ? body.left + (body.width - tile.labelWidth) / 2 : body.left + body.width + 2, top: tile.above ? body.top - 14 : body.top + Math.max(0, (tile.height - 14) / 2), width: tile.labelWidth, height: 14 };
    out.set(tile.id, { slot: tile.slot, compact: tile.compact, tight, body, label, cue: { ...label }, bar: { left: body.left, top: body.top + body.height - 2, width: body.width, height: 2 } });
  }
  return out;
}
