import { PART as P } from '../../src/v1/constants.js';
import { combos, glossary, incomingHelp, openingShop, receiptHelp, scoreHelp, shopHelp } from '../teaching.js';
import { escape } from './dom.js';
import { partDetail, enemyDetail } from './teaching.js';
export const guideTabs = ['Basics', 'Parts', 'Enemies', 'Combos'] as const;
export type GuideTab = typeof guideTabs[number];
export function guidePage(tab: GuideTab = 'Basics'): string {
  const body = tab === 'Basics' ? `<p>${openingShop}</p><p>${shopHelp}</p>${Object.entries(glossary).map(([term, text]) => `<div class="glossary-entry"><h3>${term}</h3><p>${escape(text)}</p></div>`).join('')}<div class="glossary-entry"><h3>Gold</h3><p>${receiptHelp}</p></div><div class="glossary-entry"><h3>Score</h3><p>${scoreHelp}</p></div>`
    : tab === 'Parts' ? [P.BALLISTA, P.CAULDRON, P.PALISADE, P.FORGE, P.WATCHTOWER, P.QUARRY].map(p => `<section class="guide-section">${partDetail(p)}</section>`).join('')
    : tab === 'Enemies' ? `<p>${incomingHelp}</p>${(['swarm', 'brute', 'gatebreaker', 'last-siege'] as const).map(key => `<section class="guide-section">${enemyDetail(key)}</section>`).join('')}`
    : `<ol class="combo-list">${combos.map(text => `<li>${escape(text)}</li>`).join('')}</ol>`;
  return `<nav class="guide-tabs" aria-label="Guide pages">${guideTabs.map(name => `<button data-command="guide-tab" data-value="${name}" aria-pressed="${name === tab}">${name}</button>`).join('')}</nav><div class="guide-page" data-guide-tab="${tab}">${body}</div>`;
}
