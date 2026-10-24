import { afterEach, describe, expect, it, vi } from 'vitest';
import { fight, forecast, newRun, withPart } from '../src/v1/sim.js';
import { scoutEnemyCopy } from './teaching.js';
import { makeTimeline } from './replay.js';
import { fightForecast } from './ui/model.js';
import { frameLog, renderBattlePanel } from './ui/battle.js';
import { scoutMarkup } from './ui/scout.js';
import { supportBadgePosition } from './ui/layout.js';

afterEach(() => vi.unstubAllGlobals());

describe('RD8 confirmed copy bugs', () => {
  it('records arrivals and shows the newest event after the opening caption', () => {
    const built = newRun(13n, 'practice'), first = makeTimeline(built, fight(built).frames)[0];
    const arrivals = frameLog(first).filter(l => l.text.includes('arrives'));
    expect(arrivals).toHaveLength(2);
    const panel = { innerHTML: '', dataset: {} };
    vi.stubGlobal('document', { querySelector: () => panel });
    renderBattlePanel(built, first.frame, [], 1);
    expect(panel.innerHTML).toContain('The siege is arriving.');
    const launch = { tick: 3n, text: 'L1 Ballista fires', value: '' };
    renderBattlePanel(built, first.frame, [...arrivals, launch], 1);
    expect(panel.innerHTML).not.toContain('The siege is arriving.');
    expect(panel.innerHTML.indexOf('L1 Ballista fires')).toBeLessThan(panel.innerHTML.indexOf('Swarm arrives'));
  });
  it('writes HP alternatives as choices, including three late Brute HP values', () => {
    for (let wave = 0n; wave < 10n; wave++) {
      const state = { ...newRun(20749n, 'practice'), wave };
      for (const kind of ['swarm', 'brute'] as const) {
        const hp = [...new Set(forecast(state).waves.flatMap(w => w.lanes.flat()).filter(g => g.kind === kind).map(g => String(g.bodyHp)))];
        const copy = scoutEnemyCopy(state, kind);
        expect(copy).not.toMatch(/\d\/\d/);
        if (hp.length > 1) expect(copy).toContain(`${hp.slice(0, -1).join(', ')} or ${hp.at(-1)} HP`);
      }
    }
  });
  it('says no walls lost only for a zero-loss build forecast', () => {
    expect(fightForecast([{ leaks: 0n }, { leaks: 0n }], 0n)).toBe('0 lanes leak · no walls lost · 0g left');
    expect(fightForecast([{ leaks: 2n }, { leaks: 0n }], 5n)).toBe('1 lane leaks · −2 walls · 5g left');
  });
  it('omits equal full-health boss forecasts and retains a different baseline', () => {
    const state = { ...newRun(13n, 'practice'), wave: 4n };
    expect(scoutMarkup(state)).not.toContain('At full health:');
    const built = withPart(withPart(state, 4n, 1n, 3n), 5n, 1n, 3n);
    expect(scoutMarkup(built)).toContain('With this build:');
    expect(scoutMarkup(built)).toContain('At full health:');
  });
  it('moves a support bonus away from a forecast warning and keeps earlier bonuses apart', () => {
    const bounds = { left: 0, top: 0, right: 200, bottom: 200 };
    const warning = { left: 70, top: 72, right: 150, bottom: 95 };
    const first = supportBadgePosition({ x: 100, y: 80 }, bounds, [warning]);
    expect(first.y + 9 + 3 <= warning.top || first.y - 9 - 3 >= warning.bottom || first.x + 13 + 3 <= warning.left || first.x - 13 - 3 >= warning.right).toBe(true);
    const second = supportBadgePosition({ x: 100, y: 80 }, bounds, [warning, { left: first.x - 13, right: first.x + 13, top: first.y - 9, bottom: first.y + 9 }]);
    expect(second).not.toEqual(first);
  });
});

import { foeMarkup, renderIncoming } from './ui/board.js';
import { inspectorMarkup } from './ui/inspector.js';
import { hitDamageText, type HitReadout } from './ui/model.js';
import { settlementText } from './copy.js';
import { blockEffects } from './battle-effects.js';

describe('RD8 clarity at the number', () => {
  it.each([0n, 1n, 2n])('puts current threats before the press-to-expand boss on wave %s', wave => {
    const html = scoutMarkup({ ...newRun(13n, 'practice'), wave });
    expect(html.indexOf('current-threats')).toBeLessThan(html.indexOf('<details class="future-boss">'));
    expect(html).toContain('<summary>Boss wave 5: Gatebreaker</summary>');
    expect(html).not.toContain('<details class="future-boss" open');
    expect(html).toContain('Wave 5 forecast: this board, no more purchases');
  });
  it('opens the boss card normally from wave 4 onward', () => {
    expect(scoutMarkup({ ...newRun(13n, 'practice'), wave: 3n })).not.toContain('future-boss');
  });
  it('pairs the wounded-front bar with a plain HP explanation', () => {
    const g = { ...forecast(newRun(13n, 'practice')).waves[0].lanes.flat()[0], count: 2n, hp: 1n, bodyHp: 3n };
    const html = foeMarkup(g);
    expect(html).toContain('class="front-hp"'); expect(html).toContain('width:33%');
    expect(html).toContain('front unit 1 of 3 HP'); expect(html).not.toContain('Front unit 1/3');
  });
  it('keeps splash per unit and names armour without hiding the applied total for mixed hits', () => {
    const hit: HitReadout = { group: 0n, cell: 0n, applied: 34n, bolt: 0n, splash: 18n, blockedBolt: 0n, blockedSplash: 1n, kills: 0n, bounty: 0n };
    expect(hitDamageText(hit, { count: 2n, hp: 20n, bodyHp: 20n })).toBe('−17×2');
    expect(hitDamageText({ ...hit, bolt: 4n, applied: 38n }, { count: 2n, hp: 20n, bodyHp: 20n })).toBe('−38');
    const built = { ...newRun(13n, 'practice'), wave: 4n };
    const steps = makeTimeline(withPart(built, 13n, 2n, 1n), fight(withPart(built, 13n, 2n, 1n)).frames);
    expect(steps.flatMap(blockEffects).some(e => e.text === 'Armour −1')).toBe(true);
  });
  it('spells out Tier and Depth in the selected-cell panel', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const html = inspectorMarkup(withPart(newRun(13n, 'practice'), 1n, 1n, 1n), 1n);
    expect(html).toContain('Tier 1 · Lane 1 · Depth 2');
    expect(html).not.toMatch(/\stitle=/);
  });
  it('adds specific arrival and Heavy notes to the actual incoming entries', () => {
    const rows: { innerHTML: string; dataset: object; style: object }[] = [], hosts: { innerHTML: string }[] = [];
    const host = () => { const h = { innerHTML: '', dataset: {}, classList: { toggle: vi.fn() }, querySelector: () => null, querySelectorAll: () => [], append: vi.fn(), insertAdjacentHTML: (_p: string, html: string) => { h.innerHTML += html; } }; hosts.push(h); return h; };
    vi.stubGlobal('document', { querySelector: host, querySelectorAll: () => [], createElement: () => { const row = { innerHTML: '', dataset: {}, style: {}, querySelector: () => null }; rows.push(row); return row; } });
    renderIncoming({ ...newRun(13n, 'practice'), wave: 4n });
    expect(rows.some(r => r.innerHTML.includes('data-help-note="arrives on tick 2"'))).toBe(true);
    expect(hosts.some(h => h.innerHTML.includes('data-help-note="Extra Brutes in this lane this wave."'))).toBe(true);
    expect(rows.every(r => !/\stitle=/.test(r.innerHTML))).toBe(true);
  });
  it('names clean-lane gold on the receipt', () => {
    let built = newRun(13n, 'practice'); built = withPart(withPart(built, 1n, 1n, 3n), 5n, 2n, 3n);
    expect(settlementText(fight(built).summary)).toContain('Clean lanes +2');
  });
});

import { damageNumberPosition } from './ui/layout.js';
it('fits the 360×640 wave-10 armour caption in the last free row without covering either Brute chip', () => {
  const cell = { left: 270, top: 258, right: 347, bottom: 319 };
  const chips = [{ left: 310.5, top: 286, right: 345, bottom: 303 }, { left: 308, top: 268, right: 346, bottom: 285 }];
  const body = { left: 290, top: 321, right: 345, bottom: 340 };
  const spot = damageNumberPosition(body, cell, { width: 66, height: 14 }, chips, 259)!;
  expect(spot).toBeTruthy(); expect(spot.top).toBe(305); expect(spot.bottom).toBe(319);
  expect(spot.left).toBeGreaterThanOrEqual(cell.left); expect(spot.right).toBeLessThanOrEqual(cell.right);
});

import { renderBanner } from './ui/hud.js';
it('fits full Armour wording below the three seed-4 wave-10 entrance chips and Heavy badge', () => {
  const cell = { left: 206, top: 121, right: 290.171875, bottom: 196.734375 };
  const obstacles = [
    { left: 250.75, top: 166, right: 289.171875, bottom: 183 },
    { left: 212.125, top: 157, right: 241.953125, bottom: 174 },
    { left: 251.40625, top: 148, right: 286.828125, bottom: 165 },
    { left: 248.171875, top: 121, right: 289.171875, bottom: 139 },
  ];
  const body = { left: 240, top: cell.bottom + 3, right: 280, bottom: 214 };
  expect(damageNumberPosition(body, cell, { width: 66, height: 14 }, obstacles, cell.top + 1)).toBeNull();
  const spot = damageNumberPosition(body, cell, { width: 66, height: 12 }, obstacles, cell.top + 1)!;
  expect(spot.top).toBeGreaterThanOrEqual(185);
  expect(spot.bottom).toBeLessThanOrEqual(cell.bottom + 1);
});

import { soundButton } from './ui/sound.js';
it('keeps the two-line armour fallback beside Heavy and above the 360px entrance chips', () => {
  const cell = { left: 191, top: 121, right: 268, bottom: 192 };
  const obstacles = [
    { left: 230, top: 165, right: 267, bottom: 182 },
    { left: 194, top: 156, right: 224, bottom: 173 },
    { left: 231, top: 147, right: 267, bottom: 164 },
    { left: 226, top: 121, right: 267, bottom: 139 },
  ];
  const spot = damageNumberPosition({ left: 230, right: 267, top: 156, bottom: 178 }, cell, { width: 30, height: 28 }, obstacles, 122)!;
  expect(spot).toBeTruthy();
  expect(spot.right).toBeLessThanOrEqual(224);
  expect(spot.bottom).toBeLessThanOrEqual(154);
});

import { helpDescriptions } from './ui/teaching.js';
it('keeps tick and sound help in described notes, without native tooltip titles', () => {
  const banner = { className: '', innerHTML: '' };
  vi.stubGlobal('document', { querySelector: () => banner });
  renderBanner('battle', newRun(13n, 'practice'), 3n, 0n);
  expect(banner.innerHTML).toContain('data-help-note="Tick 3"');
  expect(banner.innerHTML).toContain('data-help="Storm" aria-describedby="help-Storm"');
  expect(banner.innerHTML).not.toMatch(/\stitle=/);
  expect(soundButton()).toContain('aria-describedby="help-Sound"');
  expect(soundButton()).not.toMatch(/\stitle=/);
  expect(helpDescriptions()).toContain('M toggles mute.');
});
