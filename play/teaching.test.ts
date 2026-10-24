import { describe, expect, it } from 'vitest';
import { newRun, withPart, applyAction, shop } from '../src/v1/sim.js';
import { PART as P } from '../src/v1/constants.js';
import { cardReason, inspectorReason } from './availability.js';
import { actionRows } from './ui/model.js';

describe('teaching at the action', () => {
  it('names the purchased part before consuming its offer', () => {
    const start = newRun(13n, 'practice');
    const rows = actionRows(start, [{ type: 'buy', slot: 1n, cell: 1n }, { type: 'upgrade', cell: 1n }]);
    expect(rows.all[0]).toMatchObject({ part: P.BALLISTA, text: 'Buy Ballista at L1 D2' });
    expect(rows.all[1].text).toBe('Upgrade Ballista to tier 2 at L1 D2');
  });
  it('prints each of the four card reasons with first-match priority', () => {
    const start = newRun(13n, 'practice');
    const bought = applyAction(start, { type: 'buy', slot: 1n, cell: 1n });
    expect(cardReason({ ...bought, actionsUsed: 6n, gold: 0n }, 1)).toBe('No actions left. Fight, or undo one.');
    expect(cardReason({ ...bought, gold: 0n }, 1)).toBe('Bought. A reroll or the next wave brings new offers.');
    expect(cardReason({ ...start, gold: 0n }, 1)).toBe(`Need ${shop(start)[1].price} more gold.`);
    let full = { ...start, gold: 100n };
    for (let cell = 0n; cell < 16n; cell++) full = withPart(full, cell, P.PALISADE, 1n);
    expect(cardReason(full, 1)).toBe('Every cell is full. Sell a part first.');
    expect(cardReason(start, 1)).toBe('');
  });
  it('prints all five inspector reasons, plus the support restriction', () => {
    const base = withPart(newRun(13n, 'practice'), 0n, P.BALLISTA, 3n);
    expect(inspectorReason(base, 0n, 'upgrade')).toBe('Max tier');
    expect(inspectorReason(withPart(base, 0n, P.BALLISTA, 2n), 0n, 'overclock')).toBe('Tier 3 only');
    expect(inspectorReason({ ...base, overclocked: 1n }, 0n, 'overclock')).toBe('Overclocked for this fight');
    expect(inspectorReason({ ...base, gold: 0n }, 0n, 'overclock')).toBe('Need 8 more gold');
    expect(inspectorReason({ ...base, actionsUsed: 6n }, 0n, 'overclock')).toBe('No actions left');
    expect(inspectorReason(withPart(base, 0n, P.FORGE, 3n), 0n, 'overclock')).toBe('Weapons and Palisades only');
    expect(inspectorReason(base, 0n, 'sell')).toBe('');
  });
});

import { C } from '../src/v1/constants.js';
import { fight } from '../src/v1/sim.js';
import { supportLinks, boostedWeapons, wallExplanation, suggestedPlacement } from './board-teaching.js';
import { statsAt } from './parts.js';
import { enemyLessons, glossary, partLesson } from './teaching.js';
import { partDetail, enemyDetail } from './ui/teaching.js';

describe('board teaching', () => {
  it('links every touching Forge, including across lanes, without diagonals or edge wrapping', () => {
    let state = withPart(newRun(13n, 'practice'), 5n, P.BALLISTA, 2n);
    for (const cell of [1n, 4n, 6n, 9n, 0n, 10n]) state = withPart(state, cell, P.FORGE, 1n);
    expect(supportLinks(state).map(link => [link.from, link.to, link.bonus])).toEqual([[4n, 5n, 4n], [6n, 5n, 4n], [1n, 5n, 4n], [9n, 5n, 4n]]);
    const edge = withPart(withPart(newRun(13n, 'practice'), 3n, P.BALLISTA, 1n), 4n, P.FORGE, 3n);
    expect(supportLinks(edge)).toEqual([]);
  });
  it('uses the row maximum once, handles ties, and drops disabled supports and weapons', () => {
    let state = withPart(newRun(13n, 'practice'), 1n, P.BALLISTA, 3n);
    for (const [cell, tier] of [[5n, 1n], [9n, 3n], [13n, 3n]]) state = withPart(state, cell, P.WATCHTOWER, tier);
    expect(supportLinks(state)).toEqual([{ from: 9n, to: 1n, bonus: 9n, kind: 'tower' }]);
    expect(supportLinks(state, 1n << 9n)[0].from).toBe(13n);
    expect(supportLinks(state, 1n << 1n)).toEqual([]);
    expect(boostedWeapons(state, withPart(state, 0n, P.FORGE, 1n))).toEqual([{ cell: 1n, bonus: 6n, damage: 27n }]);
  });
  it('matches ghost weapon damage to simulator shots for every weapon, weapon tier, Forge tier, tower tier and overclock state', () => {
    let checked = 0;
    for (const weapon of [P.BALLISTA, P.CAULDRON]) for (const tier of [1n, 2n, 3n])
      for (const forge of [0n, 1n, 2n, 3n]) for (const tower of [0n, 1n, 2n, 3n]) for (const oc of tier === 3n ? [false, true] : [false]) {
        let state = withPart({ ...newRun(13n, 'practice'), wave: 9n }, 1n, weapon, tier);
        if (forge) state = withPart(state, 5n, P.FORGE, forge);
        if (tower) state = withPart(state, 9n, P.WATCHTOWER, tower);
        if (oc) state = { ...state, overclocked: 1n << 1n };
        const frames = fight(state).frames;
        const damages = frames.flatMap(f => weapon === P.BALLISTA ? f.shots.filter(s => s.from === 1n).map(s => s.damage) : f.splashes.filter(s => s.from === 1n).flatMap(s => s.targets.map(t => t.damage)));
        expect(damages.length).toBeGreaterThan(0);
        expect(damages[0], `${weapon}/${tier}/${forge}/${tower}/${oc}`).toBe(statsAt(state, 1n).value);
        checked++;
      }
    expect(checked).toBe(128);
  });
  it('matches tier stats for Palisades and Quarry income to the sim', () => {
    for (const tier of [1n, 2n, 3n]) {
      const fence = withPart(newRun(13n, 'practice'), 10n, P.PALISADE, tier);
      expect(fight(fence).frames[0].palisades.find(p => p.cell === 10n)?.hp).toBe(statsAt(fence, 10n).hp);
      const quarry = withPart(newRun(13n, 'practice'), 10n, P.QUARRY, tier);
      expect(fight(quarry).summary.quarry).toBe(statsAt(quarry, 10n).income);
      expect(partLesson(P.PALISADE).tiers[Number(tier - 1n)]).toBe(String(C.PALISADE_HP * tier));
    }
  });
  it('explains an empty lane, an uncovered leak and a defended lane from real forecasts', () => {
    const start = newRun(13n, 'practice');
    expect(wallExplanation(start, 2n)).toBe('Lane 3 holds: no enemies come down it this wave.');
    expect(wallExplanation(start, 0n)).toBe('Lane 1 leaks 2: 2 Swarm reach the wall and nothing covers D1 to D4.');
    expect(wallExplanation(withPart(start, 1n, P.BALLISTA, 1n), 0n)).toContain('holds: your weapons kill all 2 enemies');
  });
});

it('keeps all parts, enemies and glossary definitions in the shared teaching source', () => {
  for (const p of [P.BALLISTA, P.CAULDRON, P.PALISADE, P.FORGE, P.WATCHTOWER, P.QUARRY]) {
    const html = partDetail(p);
    for (const label of ['Works with', p === P.PALISADE ? 'Limit' : 'Weak against', 'range-strip', 'Buy / to tier 2 / to tier 3']) expect(html).toContain(label);
  }
  for (const key of Object.keys(enemyLessons) as (keyof typeof enemyLessons)[]) expect(enemyDetail(key)).toContain(enemyLessons[key].name);
  expect(Object.keys(glossary)).toHaveLength(13);
  expect(glossary.Damage).toContain('HP lost');
});

import { guidePage } from './ui/guide.js';
it('puts every teaching rule on the four Guide pages', () => {
  expect(guidePage()).toContain('data-guide-tab="Basics"');
  for (const term of Object.keys(glossary)) expect(guidePage()).toContain(`<h3>${term}</h3>`);
  for (const name of ['Ballista', 'Cauldron', 'Palisade', 'Forge', 'Watchtower', 'Quarry']) expect(guidePage('Parts')).toContain(`<h3>${name}</h3>`);
  for (const name of ['Swarm', 'Brute', 'Gatebreaker', 'Last Siege']) expect(guidePage('Enemies')).toContain(name);
  expect(guidePage('Combos').match(/<li>/g)).toHaveLength(7);
});


import { inspectorMarkup } from './ui/inspector.js';
it('shows the extra Palisade HP in the charged inspector equation', () => {
  const state = { ...withPart(newRun(13n, 'practice'), 0n, P.PALISADE, 3n), overclocked: 1n };
  expect(inspectorMarkup(state, 0n)).toContain('16 HP × tier 3 + 12 Overclock');
  expect(inspectorMarkup(state, 0n)).toContain('>60</b>');
});

it('previews a Palisade in front of a placed weapon', () => {
  const state = withPart(newRun(13n, 'practice'), 1n, P.BALLISTA, 1n);
  expect(suggestedPlacement(state, P.PALISADE)).toBe(2n);
});

import { partSummary, helpAttributes, helpDescriptions, helpCopy } from './ui/teaching.js';
it('keeps hover help short, with the full article behind the ⓘ button and no native tooltips', () => {
  for (const p of [P.BALLISTA, P.CAULDRON, P.PALISADE, P.FORGE, P.WATCHTOWER, P.QUARRY]) {
    const html = partSummary(p);
    expect(html.match(/<p\b/g)).toHaveLength(3);
    expect(html).toContain(`${partLesson(p).costs[0]}g`);
    expect(html).toContain('Full details: ⓘ');
    expect(html).not.toContain('tier-table');
  }
  for (const key of Object.keys(helpCopy)) {
    expect(helpAttributes(key)).toBe(`data-help="${key}" aria-describedby="help-${key}"`);
    expect(helpDescriptions()).toContain(`<span id="help-${key}">`);
  }
});
