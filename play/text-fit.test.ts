import { describe, expect, it } from 'vitest';
import { auditTextBoxes, type TextBox } from './ui/layout.js';

const box = (name: string, patch: Partial<TextBox> = {}): TextBox => ({
  name, bounds: { left: 10, top: 10, right: 110, bottom: 30 },
  parent: { left: 0, top: 0, right: 120, bottom: 40 },
  clientWidth: 100, clientHeight: 20, scrollWidth: 100, scrollHeight: 20,
  ellipsis: false, overlay: false, ...patch,
});

describe('smoke text-fit invariant', () => {
  // Modeled RD4 failures from the orchestrator audit, not claimed browser measurements.
  it.each([
    box('Forge compact effect', { scrollWidth: 144, ellipsis: true }),
    box('Inspector damage-formula', { scrollWidth: 302 }),
    box('Wave-one hint', { scrollHeight: 40 }),
    box('Placed-part pill', { scrollWidth: 112 }),
    box('Wall why', { bounds: { left: 10, top: 25, right: 110, bottom: 45 } }),
    box('Incoming ticktag', { bounds: { left: -2, top: 10, right: 110, bottom: 30 } }),
    box('Chip n/h', { bounds: { left: 10, top: 10, right: 123, bottom: 30 } }),
    box('RD5 card name, zero-sized parent', { parent: { left: 0, top: 0, right: 0, bottom: 0 } }),
  ])('rejects $name', sample => expect(auditTextBoxes([sample]).length).toBeGreaterThan(0));

  it('accepts wrapping when both the text and its box fit', () => {
    expect(auditTextBoxes([box('Wrapped Forge', { clientHeight: 40, scrollHeight: 40,
      bounds: { left: 0, top: 0, right: 120, bottom: 40 } })])).toEqual([]);
  });
  it('uses one pixel of tolerance on all four parent edges and both scroll axes', () => {
    expect(auditTextBoxes([box('Border rounding', { scrollWidth: 101, scrollHeight: 21,
      bounds: { left: -1, top: -1, right: 121, bottom: 41 } })])).toEqual([]);
    for (const bounds of [
      { left: -2, top: 0, right: 120, bottom: 40 }, { left: 0, top: -2, right: 120, bottom: 40 },
      { left: 0, top: 0, right: 122, bottom: 40 }, { left: 0, top: 0, right: 120, bottom: 42 },
    ]) expect(auditTextBoxes([box('Escape', { bounds })])).toEqual(['Escape: text box escapes parent']);
  });
  it('catches ellipsis even within the rounding tolerance', () => {
    expect(auditTextBoxes([box('Clipped', { ellipsis: true, scrollWidth: 101 })])).toEqual(['Clipped: ellipsis truncates text']);
  });
  it('checks display headings vertically and keeps overlay text-fit checks', () => {
    expect(auditTextBoxes([box('Heading', { scrollHeight: 23 })])).toEqual(['Heading: vertical text overflow (23/20)']);
    const overlay = box('Pop', { overlay: true, bounds: { left: -10, top: -10, right: 110, bottom: 50 } });
    expect(auditTextBoxes([overlay])).toEqual([]);
    expect(auditTextBoxes([{ ...overlay, scrollHeight: 23 }])).toEqual(['Pop: vertical text overflow (23/20)']);
  });
});

// Chromium measurements from eyes pl1-04-baseline, frozen RD6 at 390×844.
import rd6Badges from './fixtures/pl1-rd6-badges.json' with { type: 'json' };
it('rejects RD6 phone badges whose glyphs reach the rounded border despite equal scroll/client sizes', () => {
  expect(rd6Badges.every(b => b.scrollWidth === b.clientWidth)).toBe(true);
  expect(auditTextBoxes(rd6Badges).some(f => f.includes('text crowds badge border'))).toBe(true);
});
