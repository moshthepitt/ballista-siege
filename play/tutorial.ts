import { C, PART as P } from '../src/v1/constants.js';
import { forecast, newRun, partAt, shop, type Action, type RunState, type TickFrame } from '../src/v1/sim.js';
import { synergy } from './teaching.js';
export const TUTORIAL_KEY = 'ballista:siege:tutorial';
type LaterHint = 'palisade' | 'brute' | 'support' | 'boss' | 'trample';
export interface TutorialState { done: boolean; step: number; lanes: bigint[]; seen: LaterHint[]; active?: LaterHint; support?: bigint; trample?: bigint }
export interface TutorialContext { state: RunState; phase: 'build' | 'battle' | 'summary' | 'end'; selected?: bigint; tick?: bigint; frame?: TickFrame | null; action?: Action }
export interface TutorialCallout { id: string; text: string; anchor: string; next: boolean }
export function createTutorial(state: RunState, saved?: { done?: boolean; seen?: LaterHint[] }): TutorialState {
  const lanes = forecast(newRun(state.seed, state.mode)).waves[0].lanes.flatMap((groups, lane) => groups.length ? [BigInt(lane)] : []);
  return { done: !!saved?.done, step: state.wave ? 7 : 0, lanes, seen: saved?.seen?.filter(key => ['palisade', 'brute', 'support', 'boss', 'trample'].includes(key)) ?? [] };
}
/** State changes follow player actions and real forecasts, never a fixed seed or timer. */
export function advanceTutorial(previous: TutorialState, c: TutorialContext, event?: 'next' | 'skip'): TutorialState {
  const t = { ...previous, seen: [...previous.seen] };
  if (t.done) return t;
  if (event === 'skip' || c.state.won) return { ...t, done: true, active: undefined };
  if (event === 'next') {
    if (t.active) t.active = undefined;
    else if (t.step === 0 || t.step === 5 || t.step === 6) t.step++;
  }
  const [lane, other] = t.lanes;
  if (c.phase === 'build' && c.state.wave === 0n) {
    const ballista = partAt(c.state, lane * 4n + 1n) === P.BALLISTA;
    const cauldron = partAt(c.state, other * 4n + 1n) === P.CAULDRON;
    if (ballista && cauldron) t.step = 4;
    else if (ballista) t.step = 3;
    else if (c.selected === P.BALLISTA) t.step = 2;
    else if (t.step >= 2) t.step = 1;
  }
  if (c.phase === 'battle' && t.step < 5) t.step = 5;
  if (c.phase === 'summary' && t.step < 6) t.step = 6;
  if (c.phase === 'build' && c.state.wave > 0n && t.step < 7) t.step = 7;
  const show = (key: LaterHint) => { t.active = key; t.seen.push(key); };
  const trampled = c.frame?.tramples.find(event => c.frame!.disabled & (1n << event.cell));
  if (c.phase === 'battle' && trampled && !t.seen.includes('trample')) {
    t.trample = trampled.cell; show('trample');
  }
  if (t.active && (c.phase === 'battle' && t.active !== 'trample' || c.action?.type === 'buy' && (
    t.active === 'palisade' && partAt(c.state, c.action.cell) === P.PALISADE || t.active === 'support' && partAt(c.state, c.action.cell) === t.support))) t.active = undefined;
  if (c.phase === 'build' && (t.active === 'palisade' || t.active === 'support') && !shop(c.state).some(o => o.available && o.part === (t.active === 'palisade' ? P.PALISADE : t.support))) t.active = undefined;
  if (t.step >= 7 && !t.active && c.phase === 'build') {
    const offers = shop(c.state).filter(offer => offer.available);
    if (!t.seen.includes('boss') && c.state.wave === 3n) show('boss');
    else if (!t.seen.includes('palisade') && c.state.wave > 0n && offers.some(o => o.part === P.PALISADE)) show('palisade');
    else if (!t.seen.includes('brute') && forecast(c.state).waves.some(w => w.lanes.flat().some(g => g.kind === 'brute'))) show('brute');
    else if (!t.seen.includes('support') && offers.some(o => o.part === P.FORGE || o.part === P.WATCHTOWER)) {
      t.support = offers.find(o => o.part === P.FORGE || o.part === P.WATCHTOWER)!.part; show('support');
    }
  }
  return t;
}
export function tutorialCallout(t: TutorialState, c: TutorialContext): TutorialCallout | null {
  if (t.done || c.phase === 'end') return null;
  const [lane, other] = t.lanes;
  if (t.active) {
    const hints: Record<LaterHint, Omit<TutorialCallout, 'id'>> = {
      palisade: { text: 'A Palisade stops enemies one cell above it. Put one in front of a weapon.', anchor: `.card[data-part="${P.PALISADE}"]`, next: true },
      brute: { text: `Brutes shrug off ${C.BRUTE_SPLASH_ARMOR} splash per tick. Ballistas or upgraded Cauldrons deal with them.`, anchor: '[data-help-enemy="brute"], [data-command="scout"], .spawn', next: true },
      support: { text: synergy(t.support!), anchor: `.card[data-part="${t.support}"]`, next: true },
      boss: { text: 'Boss next wave. Every hit lowers how many walls it takes.', anchor: '.bossbox, [data-command="scout"]', next: true },
      trample: { text: "Trampled: an enemy stepped on it. It's off until the next wave.", anchor: `[data-cell="${t.trample}"]`, next: true },
    };
    return { id: t.active, ...hints[t.active] };
  }
  const steps: TutorialCallout[] = [
    { id: 'incoming', text: `Swarm enters lanes ${lane + 1n} and ${other + 1n}. Wall badges forecast your build.`, anchor: `[data-spawn="${lane}"]`, next: true },
    { id: 'weapon', text: `Pick the Ballista. It hits its cell and ${C.BALLISTA_RANGE} cells toward the entrance.`, anchor: `.card[data-part="${P.BALLISTA}"]`, next: false },
    { id: 'place-ballista', text: `Place at lane ${lane + 1n}, D2. Its wall badge will say Holds.`, anchor: `[data-cell="${lane * 4n + 1n}"]`, next: false },
    { id: 'cauldron', text: `Now the Cauldron, at D2 in lane ${other + 1n}.`, anchor: c.selected === P.CAULDRON ? `[data-cell="${other * 4n + 1n}"]` : `.card[data-part="${P.CAULDRON}"]`, next: false },
    { id: 'fight', text: `Both lanes hold and you have ${c.state.gold} gold left. Fight.`, anchor: '[data-command="fight"]', next: false },
    { id: 'tick', text: 'Each tick: parts fire, enemies bite, then step closer.', anchor: '#board', next: true },
    { id: 'receipt', text: 'Gold: base pay, cleared lanes and kills.', anchor: '#settlement', next: true },
  ];
  if (t.step === 5 && c.phase !== 'battle' || t.step === 6 && c.phase !== 'summary') return null;
  return steps[t.step] ?? null;
}
