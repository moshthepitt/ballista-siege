export interface Rect { left: number; top: number; right: number; bottom: number }
export interface LabelBox { name: string; bounds: Rect; cell?: string; pop: boolean }
export interface TextBox {
  name: string;
  bounds: Rect;
  parent: Rect | null;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  ellipsis: boolean;
  overlay: boolean;
  inkInset?: number;
  glyphs?: Rect[];
  clips?: Rect[];
}
/** The browser supplies font/layout measurements; fixtures exercise the same invariant. */
export function auditTextBoxes(boxes: readonly TextBox[]): string[] {
  const failures: string[] = [];
  for (const box of boxes) {
    const { name, bounds: r, parent: p } = box;
    if (box.scrollWidth > box.clientWidth + 1) failures.push(`${name}: horizontal text overflow (${box.scrollWidth}/${box.clientWidth})`);
    if (box.scrollHeight > box.clientHeight + 1) failures.push(`${name}: vertical text overflow (${box.scrollHeight}/${box.clientHeight})`);
    for (const glyph of box.glyphs ?? []) {
      if (box.inkInset && (glyph.left < r.left + box.inkInset - .5 || glyph.right > r.right - box.inkInset + .5))
        failures.push(`${name}: text crowds badge border`);
      if (glyph.left < r.left - 1 || glyph.right > r.right + 1 || glyph.top < r.top - 1 || glyph.bottom > r.bottom + 1)
        failures.push(`${name}: glyphs escape text box`);
      for (const clip of box.clips ?? []) if (glyph.left < clip.left - 1 || glyph.right > clip.right + 1 || glyph.top < clip.top - 1 || glyph.bottom > clip.bottom + 1)
        failures.push(`${name}: glyphs clipped by ancestor`);
    }
    if (box.ellipsis && box.scrollWidth > box.clientWidth) failures.push(`${name}: ellipsis truncates text`);
    if (!box.overlay && p && (r.left < p.left - 1 || r.right > p.right + 1 || r.top < p.top - 1 || r.bottom > p.bottom + 1))
      failures.push(`${name}: text box escapes parent`);
  }
  return [...new Set(failures)];
}
/** Shared by smoke's in-browser observer and unit fixtures. No placement or collision solver. */
export function auditLabelBoxes(labels: readonly LabelBox[], cells: Readonly<Record<string, Rect>>): string[] {
  const failures: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i];
    for (const b of labels.slice(i + 1)) {
      const x = Math.min(a.bounds.right, b.bounds.right) - Math.max(a.bounds.left, b.bounds.left);
      const y = Math.min(a.bounds.bottom, b.bounds.bottom) - Math.max(a.bounds.top, b.bounds.top);
      // 2 px allows chip borders to touch mid-slide; any text overlap is wider than that.
      if (x > 2 && y > 2) failures.push(`${a.name} overlaps ${b.name} (${x.toFixed(1)}×${y.toFixed(1)})`);
    }
    if (a.pop) {
      const cell = a.cell === undefined ? undefined : cells[a.cell], r = a.bounds;
      if (!cell || r.left < cell.left - 1 || r.right > cell.right + 1 || r.top < cell.top - 1 || r.bottom > cell.bottom + 1)
        failures.push(`${a.name} leaves its own cell ${a.cell}`);
    }
  }
  return failures;
}

export interface Point { x: number; y: number }
/** Keep link badges near their connector, outside forecast and part labels. */
export function supportBadgePosition(point: Point, bounds: Rect, obstacles: readonly Rect[]): Point {
  for (let radius = 0; radius <= Math.max(bounds.right - bounds.left, bounds.bottom - bounds.top); radius += 20) {
    for (const [dx, dy] of [[0, -radius], [0, radius], [-radius, 0], [radius, 0], [-radius, -radius], [radius, radius]]) {
      const x = point.x + dx, y = point.y + dy;
      const box = { left: x - 13, right: x + 13, top: y - 9, bottom: y + 9 };
      if (box.left < bounds.left || box.right > bounds.right || box.top < bounds.top || box.bottom > bounds.bottom) continue;
      if (obstacles.every(r => box.right + 3 <= r.left || box.left - 3 >= r.right || box.bottom + 3 <= r.top || box.top - 3 >= r.bottom)) return { x, y };
    }
  }
  return point;
}
/** Liang–Barsky clipping also covers diagonal connectors and rounded corner detours. */
export function segmentHitsRect(a: Point, b: Point, r: Rect, gap = 0): boolean {
  let low = 0, high = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - r.left + gap], [dx, r.right + gap - a.x], [-dy, a.y - r.top + gap], [dy, r.bottom + gap - a.y]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) low = Math.max(low, t); else high = Math.min(high, t);
    if (low > high) return false;
  }
  return true;
}

/** Damage can use free space above a group without moving any actor or hiding HP. */
export function damageNumberPosition(chip: Rect, lane: Rect, size: { width: number; height: number }, obstacles: readonly Rect[], top: number): Rect | null {
  const { width, height } = size;
  const xs = [(chip.left + chip.right - width) / 2, chip.right + 3, chip.left - width - 3, lane.left + 2, lane.right - width - 2];
  for (let row = 0; row < 5; row++) {
    const y = chip.top - height - 2 - row * (height + 4);
    for (const x of xs) {
      const box = { left: x, top: y, right: x + width, bottom: y + height };
      if (x < lane.left + 1 || box.right > lane.right - 1 || y < top) continue;
      if (obstacles.some(r => box.left < r.right + 2 && box.right > r.left - 2 && box.top < r.bottom + 2 && box.bottom > r.top - 2)) continue;
      return box;
    }
  }
  return null;
}
