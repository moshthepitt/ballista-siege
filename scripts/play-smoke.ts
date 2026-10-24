import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { planner } from '../src/v1/bots/planner.js';
import { applyAction, newRun, partAt, playTurn, shop, tierAt, type Action, type RunState } from '../src/v1/sim.js';
import { partName } from '../play/parts.js';
import { auditLabelBoxes, auditTextBoxes, segmentHitsRect, type LabelBox, type Rect, type TextBox } from '../play/ui/layout.js';
import { settlementText } from '../play/copy.js';
import { planValues } from '../play/plans.js';
import { scoreRows } from '../play/ui/model.js';

// No listening socket: Chromium receives the production build through request routing.
const root = fileURLToPath(new URL('../', import.meta.url));

const output = resolve(root, '.tmp/smoke');
const args = process.argv.slice(2);
const captureCombat = args.includes('--capture-combat');
const option = (name: string) => {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const dist = resolve(root, option('--dist') ?? 'play/dist');
const requestedSeeds = option('--seeds') ?? process.env.SMOKE_SEEDS;
const count = Number(option('--count') ?? args.find(arg => /^\d+$/.test(arg)) ?? 3);
assert(Number.isSafeInteger(count) && count > 0, 'Seed count must be a positive integer');
const seeds = requestedSeeds ? requestedSeeds.split(',').map(BigInt)
  : Array.from({ length: count }, (_, i) => [4n, 13n, 12n][i] ?? BigInt(i + 11));
assert(seeds.length > 0, 'Supply at least one seed');
const viewports = [
  { name: 'desktop', width: 1920, height: 950, touch: false },
  { name: 'laptop', width: 1280, height: 720, touch: false },
  { name: 'phone', width: 390, height: 844, touch: true },
] as const;
type Viewport = { name: string; width: number; height: number; touch: boolean };
const narrow = (width: number, _height: number) => width < 1024;
const layoutSizes = [
  [360, 640], [360, 800], [375, 667], [390, 844], [430, 932], [540, 720],
  [699, 640], [700, 640], [700, 900], [768, 640], [768, 1024], [900, 700],
  [900, 1200], [1023, 1440], [1024, 1440], [1024, 640], [1024, 700], [1152, 720], [1280, 720], [1280, 800],
  [1280, 960], [1366, 650], [1366, 768], [1440, 900], [1536, 730], [1600, 900], [1920, 640],
  [1920, 950], [1920, 960], [1920, 1080], [2240, 1260], [2560, 960], [2560, 1440],
].map(([width, height]) => ({ name: `${width}x${height}`, width, height, touch: narrow(width, height) })).filter(view => !option('--sizes') || option('--sizes')!.split(',').includes(view.name));
type Turn = { start: RunState; actions: Action[]; end: RunState };
const coverage = new Set<string>();
const results: object[] = [];
await mkdir(output, { recursive: true });

function plan(seed: bigint): Turn[] {
  let state = newRun(seed, 'practice');
  const turns: Turn[] = [];
  while (!state.done) {
    const actions = planner(state);
    const result = playTurn(state, actions);
    turns.push({ start: state, actions, end: result.state });
    state = result.state;
  }
  return turns;
}

async function openPage(browser: Browser, view: Viewport, seed: bigint, tutorial = false) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    hasTouch: view.touch, isMobile: view.touch, deviceScaleFactor: 1,
    reducedMotion: 'no-preference', serviceWorkers: 'block',
    recordVideo: args.includes('--rd10-video') ? { dir: resolve(root, '.tmp/rd10/video'), size: { width: view.width, height: view.height } } : undefined,
  });
  const videoStartedAt = Date.now();
  const page = await context.newPage();
  // tsx keeps function names via an __name helper; functions passed to page.evaluate need it in the page too.
  await page.addInitScript('window.__name = (fn) => fn');
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  // Fonts are self-hosted in dist; block any other network so the smoke test stays offline.
  await page.route('https://**/*', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('http://siege.test/**', async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    if (pathname === '/favicon.ico') { await route.fulfill({ status: 204, body: '' }); return; }
    const path = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    assert(path.startsWith(`${dist}${sep}`), `Unexpected asset path: ${pathname}`);
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };
    await route.fulfill({ contentType: mime[extname(path)] ?? 'application/octet-stream', body: await readFile(path) });
  });
  await page.goto(`http://siege.test/?backend=local&tutorial=${tutorial ? 1 : 0}&mute=1&seed=${seed}&mode=practice`);
  await page.locator('#game[data-phase="build"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, videoStartedAt };
}

async function fits(page: Page, label: string): Promise<void> {
  const layout = await page.evaluate(() => {
    const scrolling = document.scrollingElement!;
    const hud = document.querySelector('.hud')!.getBoundingClientRect();
    return { height: scrolling.scrollHeight, viewport: innerHeight, width: scrolling.scrollWidth,
      viewportWidth: innerWidth, top: scrolling.scrollTop, left: scrolling.scrollLeft, hudTop: hud.top };
  });
  assert(layout.height <= layout.viewport, `${label}: page scrolls: ${JSON.stringify(layout)}`);
  assert(layout.width <= layout.viewportWidth, `${label}: page overflows horizontally`);
  assert.equal(layout.top, 0, `${label}: page scrolled vertically`);
  assert.equal(layout.left, 0, `${label}: page scrolled horizontally`);
  assert(layout.hudTop >= 0, `${label}: header cut off`);
  // The board has no layout transition. Measure every action without delaying the replay.
  const cells = await page.evaluate(() => {
    const boardNode = document.querySelector<HTMLElement>('#board')!;
    if (!boardNode.getClientRects().length || getComputedStyle(boardNode).visibility === 'hidden') return [];
    const board = boardNode.getBoundingClientRect();
    return [...document.querySelectorAll('[data-cell]')].map(cell => {
      const rect = cell.getBoundingClientRect();
      return { cell: cell.getAttribute('data-cell'), width: rect.width, height: rect.height,
        inside: rect.top >= board.top - 1 && rect.bottom <= board.bottom + 1 && rect.left >= board.left - 1 && rect.right <= board.right + 1 };
    });
  });
  assert(cells.every(cell => cell.width >= 43.9 && cell.height >= 43.9 && cell.inside), `${label}: cells too small or outside board: ${JSON.stringify(cells)}`);
  const labels = await page.evaluate<ReturnType<typeof combatLabelSnapshot>>(`(${combatLabelSnapshot.toString()})(${auditLabelBoxes.toString()})`);
  if (labels.failures.length) await writeFile(resolve(output, 'label-layout-failure.json'), JSON.stringify({ label, tick: await page.locator('#game').getAttribute('data-combat-tick'), phase: await page.locator('#game').getAttribute('data-combat-phase'), ...labels }, null, 2));
  assert.deepEqual(labels.failures, [], `${label}: board labels`);
  const cardFailures = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.card')].flatMap(card => {
    if (!card.getClientRects().length) return [];
    const effect = [...card.querySelectorAll<HTMLElement>('.stat,.eff,.compact-eff,.tutorial-eff')].find(n => n.getClientRects().length && getComputedStyle(n).display !== 'none');
    if (!effect?.textContent?.trim()) return [`${card.dataset.slot}: effect line missing`];
    const status = card.querySelector<HTMLElement>('.card-status');
    return status && status.getBoundingClientRect().top < effect.getBoundingClientRect().bottom - 1 ? [`${card.dataset.slot}: status covers effect`] : [];
  }));
  assert.deepEqual(cardFailures, [], `${label}: shop effect/status`);
  await railLayout(page, label);
  await textFits(page, label);
  await tutorialGeometry(page, label);
}

// Serialized into the page, like the combat geometry audit. Do not exempt headings or numbers.
function textSnapshot(): TextBox[] {
  const rect = (el: Element): Rect => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  const boxes: TextBox[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('#game *')) {
    if (el.closest('svg, .sr-only') || !el.getClientRects().length) continue;
    if (![...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) continue;
    const style = getComputedStyle(el), bounds = rect(el);
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top || style.visibility === 'hidden') continue;
    let visible = true;
    for (let p: HTMLElement | null = el; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < .1) visible = false;
    }
    if (!visible || [style.overflowX, style.overflowY].some(v => v === 'auto' || v === 'scroll')) continue;
    // display:contents has no box. Test against the actual containing ancestor instead.
    let parent = el.parentElement;
    while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement;
    const glyphs: Rect[] = [];
    for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
      const range = document.createRange(); range.selectNodeContents(child);
      for (const r of range.getClientRects()) glyphs.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    const clips: Rect[] = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      // display:contents generates no clipping box, even when overflow is hidden.
      if (s.display === 'contents') continue;
      // Scrollable content is inspectable by scrolling. Hidden/clip containers destroy text.
      if ([s.overflowX, s.overflowY].some(v => v === 'auto' || v === 'scroll')) break;
      if ([s.overflowX, s.overflowY].some(v => v === 'hidden' || v === 'clip')) clips.push(rect(p));
    }
    boxes.push({ glyphs, clips, inkInset: el.matches('.verdict') ? 3 : 0, name: `${el.tagName.toLowerCase()}.${el.className} "${el.textContent?.trim().slice(0, 80)}"`,
      bounds, parent: parent ? rect(parent) : null, clientWidth: el.clientWidth, clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, ellipsis: style.textOverflow === 'ellipsis',
      overlay: el.matches('.popover, .sheet, .phone-sheet, .pop, .foe-damage, .callout, .coin, .flying-coin, .wall-damage, .notice, .storm-banner'),
    });
  }
  return boxes;
}
async function textFits(page: Page, label: string): Promise<void> {
  const boxes = await page.evaluate(textSnapshot);
  const failures = auditTextBoxes(boxes);
  if (failures.length) { await writeFile(resolve(output, 'text-failure-boxes.json'), JSON.stringify({ label, failures, boxes }, null, 2)); await page.screenshot({ path: resolve(output, 'text-failure.png') }); }
  assert.deepEqual(failures, [], `${label}: text must fit its own box and parent`);
}

/** Measure rendered text and flow siblings, including the opening hint and inspector. */
async function railLayout(page: Page, label: string): Promise<void> {
  const failures = await page.evaluate(() => {
    const failures: string[] = [];
    const visible = (el: HTMLElement) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (!r.width || !r.height || s.visibility === 'hidden' || s.display === 'none') return false;
      for (let p: HTMLElement | null = el; p; p = p.parentElement) if (Number(getComputedStyle(p).opacity) < .1) return false;
      return true;
    };
    const selectors = '#shop .card, #orders, .shop-heading, #hint, #inspector, .projection-entry, #action-bar .storm-rule, #action-bar .income-rule, #action-bar .speed-control, #action-bar .main-action, #battle-panel, #settlement, #settlement>.disclose';
    const nodes = [...document.querySelectorAll<HTMLElement>(selectors)].filter(visible);
    for (const [i, a] of nodes.entries()) {
      const r = a.getBoundingClientRect(), name = a.id || a.className;
      if (r.left < -.5 || r.top < -.5 || r.right > innerWidth + .5 || r.bottom > innerHeight + .5)
        failures.push(`${name} outside viewport (${r.x},${r.y},${r.width},${r.height})`);
      // The phone inspector is deliberately a sheet over the dock.
      if (a.classList.contains('phone-sheet')) continue;
      for (const b of nodes.slice(i + 1)) {
        if (a.contains(b) || b.contains(a) || b.classList.contains('phone-sheet')) continue;
        const s = b.getBoundingClientRect();
        const x = Math.min(r.right, s.right) - Math.max(r.left, s.left), y = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
        if (x > .5 && y > .5) failures.push(`${name} overlaps ${b.id || b.className} (${x.toFixed(1)}×${y.toFixed(1)})`);
      }
    }
    for (const el of document.querySelectorAll<HTMLElement>('#game *')) {
      if (!visible(el) || el.closest('svg, .sr-only')) continue;
      if ([...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) && parseFloat(getComputedStyle(el).fontSize) < 12)
        failures.push(`Text below 12px: ${el.className} "${el.textContent?.trim()}"`);
    }
    for (const el of document.querySelectorAll<HTMLElement>('.card :is(.name,.eff,.compact-eff,.stat,.tutorial-eff,.card-rule)')) {
      if (!visible(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) failures.push(`Card text overflows: ${el.textContent}`);
      const card = el.closest('.card')!.getBoundingClientRect(), r = el.getBoundingClientRect();
      if (r.left < card.left || r.right > card.right || r.top < card.top || r.bottom > card.bottom) failures.push(`Card text escapes: ${el.textContent}`);
    }
    if (innerWidth >= 1920 && innerHeight >= 950) {
      const inspector = document.querySelector<HTMLElement>('#inspector');
      if (inspector && visible(inspector)) {
        const box = inspector.getBoundingClientRect();
        for (const action of inspector.querySelectorAll<HTMLElement>('.actions3 .act')) {
          const r = action.getBoundingClientRect();
          if (r.top < box.top || r.bottom > box.bottom) failures.push(`Inspector action hidden below fold: ${action.dataset.command}`);
        }
      }
    }
    return failures;
  });
  if (failures.length) {
    await page.screenshot({ path: resolve(output, 'rail-layout-failure.png') });
    const cards = await page.locator('#shop .card').evaluateAll(nodes => nodes.map(n => ({
      card: n.getBoundingClientRect().toJSON(), className: n.className,
      contents: [...n.querySelectorAll<HTMLElement>('.tok,.name,.eff,.compact-eff,.tutorial-eff,.card-rule')].map(el => ({ text: el.textContent, rect: el.getBoundingClientRect().toJSON(), display: getComputedStyle(el).display, font: getComputedStyle(el).fontSize })),
    })));
    await writeFile(resolve(output, 'rail-layout-failure.json'), JSON.stringify({ label, cards }, null, 2));
  }
  assert.deepEqual(failures, [], `${label}: rail layout or typography`);
}

async function activate(page: Page, view: Viewport, target: string | Locator): Promise<void> {
  const locator = typeof target === 'string' ? page.locator(target) : target;
  // Use Playwright's normal actionability and hit testing. Never force or dispatch clicks.
  if (view.touch) await locator.tap();
  else await locator.click();
  await fits(page, `after ${typeof target === 'string' ? target : 'control'}`);
}

async function shot(page: Page, prefix: string, phase: string): Promise<void> {
  await fits(page, `${prefix} ${phase}`);
  await page.screenshot({ path: resolve(output, `${prefix}-${phase}.png`), animations: 'disabled' });
}

async function hud(page: Page, state: RunState, label: string): Promise<void> {
  assert.equal((await page.locator('#walls-number').innerText()).trim(), String(state.walls), `${label}: walls`);
  assert.equal((await page.locator('#gold-number').innerText()).trim(), String(state.gold), `${label}: gold`);
}

async function visibleBuild(page: Page, view: Viewport): Promise<void> {
  if (narrow(view.width, view.height)) return;
  const visible = await page.evaluate(() => {
    const selectors = ['[data-slot="1"]', '[data-slot="2"]', '[data-slot="3"]', '[data-slot="4"]', '#reroll-desktop [data-command="reroll"]', '#action-bar .btn-go'];
    return selectors.map(selector => {
      const n = document.querySelector<HTMLElement>(selector)!, r = n.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { selector, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && r.width >= 44 && r.height >= 44, hit: !!hit && (hit === n || n.contains(hit)) };
    });
  });
  assert(visible.every(v => v.inside && v.hit), `Build cards/reroll/main clipped or covered: ${JSON.stringify(visible)}`);
  const overflow = await page.locator('.card.mini :is(.name, .eff)').evaluateAll(nodes => nodes.flatMap(n => {
    const el = n as HTMLElement;
    return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 ? [el.textContent] : [];
  }));
  assert.deepEqual(overflow, [], 'Compact card text overflows');
}
async function mainRect(page: Page): Promise<number[]> {
  return page.locator('#action-bar .btn-go').evaluate(n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
}
function sameRect(a: number[], b: number[], label: string): void {
  assert(a.every((v, i) => Math.abs(v - b[i]) <= .5), `${label}: main button moved: ${a} / ${b}`);
}
async function closeInspector(page: Page, view: Viewport): Promise<void> {
  if (await page.locator('#inspector').isVisible()) await activate(page, view, '[data-command="close-inspector"]');
}
async function move(page: Page, view: Viewport, before: RunState, action: Action): Promise<RunState> {
  const next = applyAction(before, action);
  if (action.type === 'buy') {
    await closeInspector(page, view);
    const card = page.locator(`[data-slot="${action.slot + 1n}"]`);
    if (await card.getAttribute('aria-pressed') !== 'true') await activate(page, view, card);
    assert.equal(await card.getAttribute('aria-pressed'), 'true', 'Shop selection lost');
    await hud(page, before, 'Noncommitting card selection');
    assert.equal((await page.locator('#queue-count').textContent())?.trim(), `${before.actionsUsed} of 6 actions`, 'Card selection spent an action');
    assert(await page.locator('#board .cell.target').count() > 0, 'No glowing valid tiles');
    assert.equal(await page.locator('#game').getAttribute('data-phase'), 'build');
    await activate(page, view, `[data-cell="${action.cell}"]`);
    assert((await page.locator(`[data-cell="${action.cell}"]`).getAttribute('aria-label'))?.includes(`tier ${tierAt(next, action.cell)}`), 'Purchase missed board');
  } else if (action.type === 'reroll') {
    await closeInspector(page, view);
    await activate(page, view, view.touch ? '#action-bar [data-command="reroll"]' : '#reroll-desktop [data-command="reroll"]');
  } else {
    const tile = page.locator(`[data-cell="${action.cell}"]`);
    if (!(await page.locator('#inspector').isVisible()) || await page.locator('#inspector').getAttribute('data-inspected-cell') !== String(action.cell)) {
      await closeInspector(page, view); await activate(page, view, tile);
    }
    await page.locator('#inspector:not([hidden])').waitFor();
    assert.equal(await page.locator('#inspector').getAttribute('data-inspected-cell'), String(action.cell));
    await visibleBuild(page, view);
    if (action.type !== 'sell') assert((await page.locator('#inspector').innerText()).includes('walls lost'), 'Inspector omits predicted walls delta');
    if (partName(partAt(before, action.cell)) === 'Quarry') {
      await page.locator('#inspector .math').scrollIntoViewIfNeeded();
      await shot(page, `${view.name}-quarry-inspector`, 'fit');
    }
    await activate(page, view, `#inspector [data-command="${action.type}"]`);
    if (action.type === 'sell') assert((await tile.getAttribute('aria-label'))?.includes('empty'), 'Sale missed board');
    if (action.type === 'upgrade') assert((await tile.getAttribute('aria-label'))?.includes(`tier ${tierAt(next, action.cell)}`), 'Upgrade missed board');
    if (action.type === 'overclock') assert((await tile.getAttribute('class'))?.includes('overclocked'), 'Overclock not drawn');
  }
  coverage.add(`${view.name}:${action.type}`);
  await hud(page, next, `${view.name} ${action.type}`);
  await visibleBuild(page, view);
  return next;
}

// Serialized into Chromium. All placement logic is absent: only fixed-slot geometry is checked.
function combatLabelSnapshot(audit: typeof auditLabelBoxes): { failures: string[]; count: number; parts?: unknown[]; labelBoxes?: LabelBox[] } {
  const visible = (node: HTMLElement) => {
    const r = node.getBoundingClientRect(); if (!r.width || !r.height) return false;
    let opacity = 1;
    for (let p: HTMLElement | null = node; p; p = p.parentElement) {
      const s = getComputedStyle(p); opacity *= Number(s.opacity);
      if (s.display === 'none' || s.visibility === 'hidden' || opacity < .1) return false;
    }
    return true;
  };
  const rect = (n: HTMLElement): Rect => { const r = n.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  const cells: Record<string, Rect> = {};
  document.querySelectorAll<HTMLElement>('#board [data-cell], #board [data-spawn]').forEach(n => { cells[n.dataset.cell ?? `spawn-${n.dataset.spawn}`] = rect(n); });
  const labels: LabelBox[] = [...document.querySelectorAll<HTMLElement>('#board :is(.foe, .pop, .pill, .fence-number, .verdict, .ticktag, .was, .why, .tag, .tier-tag, .trample-label, .trample-warning, .body-more, .ruler:not(.v), .lanehead, .heavy-tag, .foe-damage, .wall-loss, .shield-pop, .contact-damage, .storm-tag), #links rect')].filter(visible).map(n => ({
    name: n.tagName.toLowerCase() === 'rect' ? `support bonus "${n.parentElement?.querySelector('text')?.textContent}"` : `${n.className} "${n.textContent?.trim()}"`, bounds: rect(n), pop: n.matches('.pop,.shield-pop,.contact-damage'), cell: n.closest<HTMLElement>('[data-cell]')?.dataset.cell ?? (n.closest<HTMLElement>('[data-spawn]') ? `spawn-${n.closest<HTMLElement>('[data-spawn]')!.dataset.spawn}` : undefined),
  }));
  const failures = audit(labels, cells);
  const bodies: { group: string; name: string; bounds: Rect }[] = [];
  for (const actor of document.querySelectorAll<HTMLElement>('#board .cell .enemy-group:not(.exiting)')) {
    const formation = actor.querySelector<HTMLElement>('.formation');
    if (!formation) continue;
    const dimensions = getComputedStyle(formation), limitingSize = Math.min(parseFloat(dimensions.width) - parseFloat(dimensions.paddingLeft) - parseFloat(dimensions.paddingRight), parseFloat(dimensions.height) - parseFloat(dimensions.paddingTop) - parseFloat(dimensions.paddingBottom));
    for (const unit of actor.querySelectorAll<HTMLElement>('.unit-body:not(.vacant)')) {
      if (actor.classList.contains('compact-group') && unit.dataset.front !== 'true') continue;
      const svg = unit.querySelector('svg');
      if (!svg || !visible(unit) || svg.clientWidth === 0 || svg.clientHeight === 0) {
        failures.push(`Group ${actor.dataset.group}: living body has no painted space`); continue;
      }
      // Screen CTM includes viewBox letterboxing and the current animation transform.
      const matrix = svg.getScreenCTM(); if (!matrix) continue;
      const box = svg.getBBox();
      const corners = [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]
        .map(([x, y]) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f }));
      const bounds = { left: Math.min(...corners.map(p => p.x)), right: Math.max(...corners.map(p => p.x)), top: Math.min(...corners.map(p => p.y)), bottom: Math.max(...corners.map(p => p.y)) };
      const minimum = unit.classList.contains('boss') ? .58 : .25;
      const restInk = box.width * Math.min(svg.clientWidth / svg.viewBox.baseVal.width, svg.clientHeight / svg.viewBox.baseVal.height);
      if (restInk + 1 < limitingSize * minimum) failures.push(`Group ${actor.dataset.group}: ${unit.className} body too small in its slot (${restInk.toFixed(1)}/${limitingSize.toFixed(1)})`);
      bodies.push({ group: actor.dataset.group!, name: unit.className, bounds });
    }
  }
  if (!['Move', 'Bite'].includes(document.querySelector<HTMLElement>('#game')!.dataset.combatPhase ?? '')) {
    const readouts = [...document.querySelectorAll<HTMLElement>('#board .cell :is(.foe,.pill,.tier-tag,.fence-number,.trample-label,.foe-damage,.shield-pop)')]
      .filter(visible).map(n => ({ name: n.className, bounds: rect(n) }));
    for (const [i, body] of bodies.entries()) for (const other of [...bodies.slice(i + 1), ...readouts]) {
      const a = body.bounds, b = other.bounds;
      const x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (x > 2 && y > 2) failures.push(`Group ${body.group}: body overlaps ${other.name} (${x.toFixed(1)}×${y.toFixed(1)})`);
    }
  }
  const parts = failures.length ? [...document.querySelectorAll<HTMLElement>('#board :is(.piece,.plate,.pips,.pill,.tier-tag,.trample-warning)')].map(n => {
    const s = getComputedStyle(n);
    return { cell: n.closest<HTMLElement>('[data-cell]')?.dataset.cell, name: n.className, text: n.textContent, rect: n.getBoundingClientRect().toJSON(), width: s.width, height: s.height, transform: s.transform, flex: s.flex, direction: s.flexDirection, gap: s.gap, font: s.font, letterSpacing: s.letterSpacing, padding: s.padding, position: s.position, top: s.top, bottom: s.bottom };
  }) : undefined;
  return { failures, count: labels.length, parts, labelBoxes: failures.length ? labels : undefined };
}
type LabelAudit = { battle: number; summary: number; movement: number; failures: string[]; shieldDetails?: unknown[]; layoutDetails?: ReturnType<typeof combatLabelSnapshot> };
function observeCombatLabels(snapshot: () => ReturnType<typeof combatLabelSnapshot>): void {
  const state: LabelAudit = { battle: 0, summary: 0, movement: 0, failures: [] };
  const host = window as typeof window & { siegeLabelAudit?: LabelAudit }; host.siegeLabelAudit = state;
  const sample = () => {
    if (host.siegeLabelAudit !== state) return;
    const root = document.querySelector<HTMLElement>('#game')!;
    if (root.dataset.phase === 'battle') for (const wall of document.querySelectorAll<HTMLElement>('[data-wall]')) {
      if (wall.querySelector('.verdict')?.textContent?.startsWith('Leaked') && !(JSON.parse(root.dataset.leakLanes ?? '[]') as string[]).includes(wall.dataset.wall!))
        state.failures.push(`T${root.dataset.combatTick}: L${Number(wall.dataset.wall) + 1} says Leaked before contact`);
    }
    if (root.dataset.phase === 'battle' || root.dataset.phase === 'summary') {
      state[root.dataset.phase]++;
      if (root.dataset.combatPhase === 'Move') {
        state.movement++;
        const actors = [...document.querySelectorAll<HTMLElement>('#board .enemy-group')];
        const ids = actors.map(n => n.dataset.group);
        const expected = Number(root.dataset.activeGroups);
        // Queued groups preview their units in the incoming row (.spawn-chip-host); anything else outside an actor was left behind.
        const loose = ':not(.enemy-group *):not(.spawn-chip-host *)';
        const orphan = document.querySelectorAll(`#board .unit-body${loose}, #board .formation${loose}, #board .bossbar${loose}`).length;
        if (actors.length !== expected || new Set(ids).size !== expected || orphan)
          state.failures.push(`T${root.dataset.combatTick}/Move: ${actors.length} actors, expected ${expected}; ${orphan} orphan bodies/bosses`);
      }
      const hiddenShields = [...document.querySelectorAll<HTMLElement>('.shield-pop')].filter(n => getComputedStyle(n).visibility === 'hidden');
      if (root.dataset.combatPhase === 'Hit' && hiddenShields.length) {
        state.failures.push(`T${root.dataset.combatTick}: shield cue has no free label space`);
        if (!state.shieldDetails) state.shieldDetails = hiddenShields.map(n => ({ tick: root.dataset.combatTick, group: n.dataset.hitGroup, text: n.textContent, geometry: n.dataset.noSpace ? JSON.parse(n.dataset.noSpace) : null }));
      }
      if (state.failures.length < 20) {
        const sample = snapshot();
        if (sample.failures.length && !state.layoutDetails) state.layoutDetails = sample;
        state.failures.push(...sample.failures.map(f => `T${root.dataset.combatTick}/${root.dataset.combatPhase}: ${f}`));
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
async function startLabelAudit(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const __name = fn => fn;
    const audit = (${auditLabelBoxes.toString()});
    const textAudit = (${auditTextBoxes.toString()});
    const textSnapshot = (${textSnapshot.toString()});
    const snapshot = () => {
      const sample = (${combatLabelSnapshot.toString()})(audit);
      sample.failures.push(...textAudit(textSnapshot()));
      return sample;
    };
    (${observeCombatLabels.toString()})(snapshot);
  })()`);
}
async function battle(page: Page, view: Viewport, start: RunState, actions: Action[], prefix: string, skip = true): Promise<void> {
  await closeInspector(page, view);
  await visibleBuild(page, view); await shot(page, prefix, 'build');
  const button = await mainRect(page), result = playTurn(start, actions);
  const built = actions.reduce((s, a) => applyAction(s, a), start);
  if (/-w(?:5|10)$/.test(prefix)) skip = false;
  const geometry = await page.locator('[data-cell]').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  await startLabelAudit(page);
  await activate(page, view, '[data-command="fight"]');
  await page.locator('#game[data-phase="battle"]').waitFor();
  sameRect(button, await mainRect(page), `${prefix} build/battle`);
  await shot(page, prefix, 'battle');
  if (skip) await activate(page, view, '[data-command="skip"]');
  const deadline = Date.now() + 30000, frames: object[] = [];
  let crowdedProof = false;
  while (await page.locator('#game').getAttribute('data-phase') === 'battle') {
    await fits(page, `${prefix} battle`);
    const sample = await page.evaluate(() => ({
      tick: document.querySelector<HTMLElement>('#game')!.dataset.combatTick,
      phase: document.querySelector<HTMLElement>('#game')!.dataset.combatPhase,
      cells: [...document.querySelectorAll('[data-cell]')].map(n => { const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }),
      // A boss-death shake transforms #board on purpose; layout reflow is what this check guards against.
      shaking: document.querySelector('#board')!.getAnimations().length > 0,
    }));
    if (!view.touch && !sample.shaking && await page.locator('#game').getAttribute('data-phase') === 'battle')
      assert(sample.cells.every((r, i) => r.every((v, axis) => Math.abs(v - geometry[i][axis]) < .2)), `${prefix}: desktop board moved during battle`);
    frames.push(sample);
    if (!crowdedProof && prefix === '1024x640-four-group-w10' && sample.tick === '5') {
      await page.screenshot({ path: resolve(output, `${prefix}-fixed-bodies.png`), animations: 'allow' });
      crowdedProof = true;
    }
    if (captureCombat && !skip) await page.screenshot({ path: resolve(output, `${prefix}-f-${String(frames.length).padStart(3, '0')}-t${sample.tick}-${sample.phase}.png`), animations: 'allow' });
    assert(Date.now() < deadline, `${prefix}: replay timeout`); await page.waitForTimeout(40);
  }
  assert.equal(await page.locator('#game').getAttribute('data-phase'), 'summary');
  await hud(page, result.state, `${prefix} summary`);
  sameRect(button, await mainRect(page), `${prefix} build/summary`);
  const settlement = page.locator('#settlement');
  assert(await settlement.isVisible(), 'Settlement missing'); assert.equal(await settlement.getAttribute('aria-hidden'), 'false');
  const total = result.summary.income + result.summary.clear + result.summary.quarry + result.summary.bounty + result.summary.salvage;
  assert.equal(await settlement.getAttribute('data-total'), String(total), 'Settlement total differs from sim');
  assert.equal(await settlement.locator('.receipt .r:not(.total) b').filter({ hasText: /^\+0$/ }).count(), 0, 'Zero receipt rows remain');
  assert.equal(await settlement.locator('.flying-coin').count(), 0, 'Coin inserted into receipt');
  assert((await settlement.locator('.settlement-inline').textContent())?.includes(settlementText(result.summary)), 'Settlement terms missing');
  assert.equal(result.state.gold - built.gold, total, 'Payout double counted');
  const rect = await settlement.boundingBox(); assert(rect && rect.y >= 0 && rect.y + rect.height <= view.height, 'Settlement clipped');
  await shot(page, prefix, 'summary');
  await page.waitForFunction(() => !document.querySelector('.flying-coin'), undefined, { timeout: 1500 });
  const audit = await page.evaluate(() => (window as typeof window & { siegeLabelAudit: LabelAudit }).siegeLabelAudit);
  assert(audit.battle > 0 && audit.summary > 0, `${prefix}: missing label samples`);
  if (!skip) assert(audit.movement > 0, `${prefix}: Move never sampled`);
  if (captureCombat || audit.failures.length) await writeFile(resolve(output, `${prefix}-combat.json`), JSON.stringify({ frames, audit }, null, 2));
  assert.deepEqual(audit.failures, [], `${prefix}: label collision or escaped pop`);
}
async function practiceReplan(page: Page, view: Viewport, turns: Turn[], prefix: string): Promise<void> {
  const index = Math.max(0, turns.findIndex(t => t.end.walls < t.start.walls));
  const markup = await page.locator('#end-screen').innerHTML(), saved = await page.evaluate(() => JSON.stringify(localStorage));
  await page.evaluate(() => {
    (window as typeof window & { siegeHooks: Element[] }).siegeHooks = [...document.querySelectorAll('#board, #action-bar')];
  });
  await activate(page, view, `[data-recap-wave="${index}"]`);
  await page.locator('#game[data-phase="build"][data-practice="true"]').waitFor();
  const turn = turns[index]; let state = turn.start;
  await hud(page, state, 'Replan starts before old purchases');
  assert((await page.locator('#hud').innerText()).includes('UNRANKED'), 'Unranked label absent');
  for (const offer of shop(state)) assert((await page.locator(`[data-slot="${offer.slot + 1n}"]`).getAttribute('aria-label'))?.startsWith(`${partName(offer.part)}, ${offer.price} gold`), 'Replan shop differs');
  for (let i = 0n; i < 16n; i++) assert((await page.locator(`[data-cell="${i}"]`).getAttribute('aria-label'))?.includes(partAt(state, i) ? `${partName(partAt(state, i))} tier ${tierAt(state, i)}` : 'empty'), 'Replan restored built state');
  for (const a of turn.actions) state = await move(page, view, state, a);
  await battle(page, view, turn.start, turn.actions, `${prefix}-replan`);
  await activate(page, view, '[data-command="continue-summary"]');
  await page.locator('#game[data-phase="end"][data-practice="true"]').waitFor();
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), saved, 'Replan changed best');
  await activate(page, view, '[data-command="return-result"]');
  await hud(page, turns.at(-1)!.end, 'Completed result restored');
  assert.equal(await page.locator('#end-screen').innerHTML(), markup, 'Replan changed completed report');
  assert(await page.evaluate(() => (window as typeof window & { siegeHooks: Element[] }).siegeHooks.every(n => document.getElementById(n.id) === n)), 'Replan replaced live board/action hooks');
  coverage.add(`${view.name}:replan`);
}
async function regressions(browser: Browser, view: Viewport): Promise<void> {
  const { context, page, errors } = await openPage(browser, view, 4n);
  try {
    const initial = newRun(4n, 'practice');
    const planned = await move(page, view, initial, { type: 'buy', slot: 0n, cell: 0n });
    await activate(page, view, '[data-command="plan"][data-value="B"]:visible');
    await hud(page, initial, 'Plan B is independent');
    assert((await page.locator('[data-cell="0"]').getAttribute('aria-label'))!.includes('empty'));
    const a = planValues(planned), b = planValues(initial);
    for (const [name, values] of [['A', a], ['B', b]] as const) {
      const text = await page.locator(`#orders .plan-values[data-plan="${name}"]`).count() ? await page.locator(`#orders .plan-values[data-plan="${name}"]`).textContent() : null;
      // Roomy desktops put the comparison in Scout; phone keeps the same source in Orders.
      const shown = text ?? await page.locator(`#scout-rail .plan-values[data-plan="${name}"]`).textContent();
      assert(shown?.includes(`W${values.wave}: ${values.loss}`));
      assert(shown?.includes(`Next 2: ${values.nextTwoLoss}`));
      assert(shown?.includes(`${values.gold}g left`));
      assert(shown?.includes(`${values.actions}/6 actions`));
    }
    await activate(page, view, '[data-command="plan"][data-value="A"]:visible');
    await hud(page, planned, 'Plan A queue restored');
    await activate(page, view, '[data-command="undo"]:visible');
    await hud(page, initial, 'Plan A undo restored opening');

    if (await page.locator('#scout-rail').isVisible()) await activate(page, view, '#game .projection-entry');
    else await activate(page, view, view.touch ? '[data-command="scout"].phone-scout' : '.strip [data-command="scout"]');
    assert(await page.locator('#sheet').isVisible(), 'Scout/projection did not open');
    await page.keyboard.press('Escape'); assert(!(await page.locator('#sheet').isVisible()), 'Esc failed');
    let state = newRun(4n, 'practice');
    const first: Action[] = [{ type: 'buy', slot: 2n, cell: 2n }, { type: 'upgrade', cell: 2n }, { type: 'upgrade', cell: 2n }];
    for (const a of first) state = await move(page, view, state, a);
    await shot(page, `${view.name}-regression`, 'inspector'); await visibleBuild(page, view);
    await battle(page, view, newRun(4n, 'practice'), first, `${view.name}-regression-w1`, false);
    await page.keyboard.press('Enter'); await page.locator('#game[data-phase="build"]').waitFor();
    const secondStart = state = playTurn(newRun(4n, 'practice'), first).state;
    const second: Action[] = [{ type: 'overclock', cell: 2n }, { type: 'sell', cell: 2n }, { type: 'reroll' }];
    for (const a of second) state = await move(page, view, state, a);
    await battle(page, view, secondStart, second, `${view.name}-regression-w2`);
    await page.keyboard.press('Space'); await page.locator('#game[data-phase="build"]').waitFor();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}
async function sixOrders(browser: Browser): Promise<void> {
  const view = viewports[0], { context, page } = await openPage(browser, view, 4n);
  try {
    let state = newRun(4n, 'practice');
    const actions: Action[] = [{ type: 'buy', slot: 0n, cell: 0n }, { type: 'buy', slot: 1n, cell: 4n }, { type: 'buy', slot: 2n, cell: 1n }, { type: 'sell', cell: 1n }, { type: 'reroll' }, { type: 'reroll' }];
    for (const action of actions) state = await move(page, view, state, action);
    assert.equal(await page.locator('#orders .order:not(.more-orders)').count(), 2, 'Queue must show last two');
    assert((await page.locator('.more-orders').innerText()).includes('+4 more'));
    assert.equal((await page.locator('#queue-count').innerText()).trim(), '6 of 6 actions');
    await activate(page, view, '.more-orders'); assert.equal(await page.locator('#sheet .order').count(), 6);
    await page.keyboard.press('Escape'); await visibleBuild(page, view); await shot(page, 'desktop-six-orders', 'build');
  } finally { await context.close(); }
}
/** Teaching uses the same fit audit and real input as the game. */
async function teachingChecks(browser: Browser, view: Viewport): Promise<void> {
  const { context, page, errors } = await openPage(browser, view, 13n);
  try {
    for (const part of ['1', '2', '3', '4']) {
      await activate(page, view, `[data-command="part-info"][data-value="${part}"]`);
      assert(await page.locator('#sheet .tier-table').isVisible(), `${view.name}: part detail missing`);
      await page.keyboard.press('Escape');
    }
    await activate(page, view, '[data-enemy-inspect="0"]');
    assert((await page.locator('#sheet').innerText()).includes('Splash handles them.'));
    await page.keyboard.press('Escape');
    if (view.touch) { await activate(page, view, '[data-command="scout"]:visible'); await activate(page, view, '#sheet [data-command="guide"]'); }
    else await activate(page, view, '[data-command="guide"]:visible');
    for (const tab of ['Basics', 'Parts', 'Enemies', 'Combos']) {
      await activate(page, view, `[data-command="guide-tab"][data-value="${tab}"]`);
      assert(await page.locator(`[data-guide-tab="${tab}"]`).isVisible());
      // Scroll to the last lesson too, so late content and sticky tabs get measured.
      await page.locator('#sheet .sheet-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await textFits(page, `${view.name}: ${tab} last lesson`);
      await page.locator('#sheet .sheet-body').evaluate(el => { el.scrollTop = 0; });
    }
    await page.keyboard.press('Escape'); assert(await page.locator('#sheet').isHidden());
    await activate(page, view, '.gold-stat'); assert((await page.locator('#sheet').innerText()).includes('nonempty lane'));
    await page.keyboard.press('Escape');
    await activate(page, view, '[data-slot="2"]'); await activate(page, view, '[data-cell="1"]');
    const boughtText = await page.locator('[data-slot="2"]').innerText();
    for (const word of ['Bought', 'next wave', 'reroll']) assert(boughtText.toLowerCase().includes(word.toLowerCase()), `${view.name}: bought card omits ${word}`);
    assert((await page.locator('[data-slot="2"]').getAttribute('aria-label'))!.includes('Bought.'));
    await activate(page, view, '[data-slot="4"]');
    assert.equal(await page.locator('#links .tether').count(), 1);
    assert((await page.locator('[data-cell="1"] .boost-pill').innerText()).includes('6 dmg'));
    await page.keyboard.press('Escape');
    await activate(page, view, '[data-wall="2"]'); assert((await page.locator('#sheet').innerText()).includes('no enemies come down it'));
    await page.keyboard.press('Escape'); assert.deepEqual(errors, []);
  } finally { await context.close(); }
  const guided = await openPage(browser, view, 13n, true);
  try {
    const p = guided.page;
    const anchored = async () => { await tutorialGeometry(p, view.name, true); await textFits(p, `${view.name}: tutorial`); };
    await anchored(); await activate(p, view, '[data-command="tutorial-next"]'); await anchored();
    await activate(p, view, '[data-slot="2"]'); await anchored();
    await activate(p, view, '[data-cell="1"]'); await activate(p, view, '[data-slot="1"]'); await anchored();
    await activate(p, view, '[data-cell="5"]'); await anchored();
    await activate(p, view, '[data-command="fight"]'); await anchored();
    await activate(p, view, '[data-command="skip"]'); await p.locator('#game[data-phase="summary"]').waitFor(); await anchored();
    await activate(p, view, '[data-command="tutorial-skip"]'); assert(await p.locator('#tutorial-layer').isHidden());
    await p.reload(); assert(await p.locator('#tutorial-layer').isHidden(), 'Skip must survive reload');
    assert.deepEqual(guided.errors, []);
  } finally { await guided.context.close(); }
  console.log(`PASS ${view.name} teaching and tutorial`);
}
async function audioControls(page: Page, view: Viewport): Promise<void> {
  // Use the first real gesture to catch audio unlock swallowing the settings click.
  const hudButton = page.locator('#hud [data-command="sound"]');
  const inStatus = !(await hudButton.isVisible());
  if (inStatus) await activate(page, view, '[data-command="status"]');
  const selector = `${inStatus ? '#sheet' : '#hud'} [data-command="sound"]`;
  const target = await page.locator(selector).boundingBox();
  assert(target && target.width >= 44 && target.height >= 44, `${view.name}: sound target below 44px`);
  await activate(page, view, selector);
  await page.locator('.sound-controls').waitFor();
  await fits(page, `${view.name} sound open`);
  for (const [key, value] of [['music', '35'], ['sfx', '65']] as const) {
    const slider = page.locator(`[data-audio-volume="${key}"]`);
    await slider.focus(); await page.keyboard.press('Home');
    for (let i = 0; i < Number(value) / 5; i++) await page.keyboard.press('ArrowRight');
    // Range steps are 1; verify the actual persisted value, independent of defaults.
    const actual = Number(await slider.inputValue());
    assert.equal(await page.locator(`[data-audio-output="${key}"]`).innerText(), `${actual}%`);
    assert.equal(await page.evaluate(key => JSON.parse(localStorage.getItem('ballista:siege:audio')!)[key], key), actual / 100);
  }
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('ballista:siege:audio')!).muted);
  await page.keyboard.press('m');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ballista:siege:audio')!).muted), !before, 'M must work while the sound sheet is open');
  await activate(page, view, '[data-command="mute"]');
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ballista:siege:audio')!).muted), before);
  assert.equal(await page.locator('[data-command="mute"]').getAttribute('aria-pressed'), 'true', 'mute=1 must keep smoke silent');
  await page.keyboard.press('Escape');
  assert(await page.locator('#sheet').isHidden());
  await fits(page, `${view.name} sound closed`); coverage.add(`${view.name}:sound`);
}
async function tutorialGeometry(page: Page, label: string, required = false): Promise<void> {
  const failure = await page.evaluate(({ required, segmentSource }) => {
    const layer = document.querySelector<HTMLElement>('#tutorial-layer')!;
    if (layer.hidden) return required ? 'callout missing' : '';
    const anchor = document.querySelector<HTMLElement>('.tutorial-target');
    if (!anchor) return 'target missing';
    const a = layer.getBoundingClientRect();
    if (a.left < 0 || a.top < 0 || a.right > innerWidth || a.bottom > innerHeight) return 'callout outside viewport';
    for (const node of document.querySelectorAll<HTMLElement>('.hud, #phase-banner, .ticks, .tutorial-target, #board .cell')) {
      const b = node.getBoundingClientRect();
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) return `callout covers ${node.id || node.className}`;
    }
    if (getComputedStyle(layer).pointerEvents !== 'none' || getComputedStyle(layer.querySelector('.tutorial-callout')!).pointerEvents !== 'none') return 'callout captures input';
    const hits = eval(`(${segmentSource})`) as typeof segmentHitsRect;
    const points = JSON.parse(document.querySelector<HTMLElement>('#tutorial-pointer')!.dataset.points ?? '[]') as { x: number; y: number }[];
    for (const el of document.querySelectorAll<HTMLElement>('#game *')) {
      if (el.closest('svg, .sr-only') || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') continue;
      for (const child of el.childNodes) if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
        const range = document.createRange(); range.selectNodeContents(child);
        for (const rect of range.getClientRects()) for (let i = 1; i < points.length; i++) if (hits(points[i - 1], points[i], rect)) return `connector crosses text: ${child.textContent}`;
      }
    }
    return '';
  }, { required, segmentSource: segmentHitsRect.toString() });
  assert.equal(failure, '', `${label}: tutorial geometry`);
}
async function laterTutorials(browser: Browser): Promise<void> {
  const turns = plan(13n);
  for (const view of [viewports[0], { name: 'short', width: 1366, height: 650, touch: false }, viewports[2]]) {
    const { context, page, errors } = await openPage(browser, view, 13n, true);
    const seen = new Set<string>();
    const capture = async () => {
      const layer = page.locator('#tutorial-layer');
      if (!await layer.isVisible()) return;
      await tutorialGeometry(page, `${view.name} later`, true);
      const id = (await layer.getAttribute('data-step'))!;
      if (seen.has(id)) return;
      await textFits(page, `${view.name} tutorial ${id}`);
      await page.screenshot({ path: resolve(output, `tutorial-later-${view.width}x${view.height}-${id}.png`) }); seen.add(id);
    };
    const dismiss = async () => {
      for (let i = 0; i < 8; i++) {
        await capture();
        if (!await page.locator('[data-command="tutorial-next"]').isVisible()) break;
        await activate(page, view, '[data-command="tutorial-next"]');
      }
    };
    try {
      for (const turn of turns) {
        await dismiss();
        let state = turn.start;
        for (const action of turn.actions) { state = await move(page, view, state, action); await capture(); }
        await closeInspector(page, view); await activate(page, view, '[data-command="fight"]'); await capture();
        if (![4n, 9n].includes(turn.start.wave)) await activate(page, view, '[data-command="skip"]');
        const deadline = Date.now() + 30000;
        while (await page.locator('#game').getAttribute('data-phase') === 'battle') { await capture(); assert(Date.now() < deadline); await page.waitForTimeout(70); }
        await dismiss(); await activate(page, view, '[data-command="continue-summary"]');
      }
      for (const id of ['palisade', 'brute', 'support', 'boss', 'trample']) assert(seen.has(id), `${view.name}: no ${id} tutorial screenshot`);
      assert.deepEqual(errors, []); console.log(`PASS ${view.name} later tutorials: ${[...seen].join(', ')}`);
    } finally { await context.close(); }
  }
}
async function tutorialSweep(browser: Browser): Promise<void> {
  for (const view of layoutSizes) {
    const { context, page, errors } = await openPage(browser, view, 13n, true);
    const check = async () => {
      await fits(page, `${view.name} guided`); await tutorialGeometry(page, view.name, true);
      const id = await page.locator('#tutorial-layer').getAttribute('data-step');
      await page.screenshot({ path: resolve(output, `tutorial-${view.name}-${id}.png`) });
    };
    try {
      await check();
      for (const selector of ['[data-command="tutorial-next"]', '[data-slot="2"]', '[data-cell="1"]', '[data-slot="1"]', '[data-cell="5"]', '[data-command="fight"]']) { await activate(page, view, selector); await check(); }
      await activate(page, view, '[data-command="skip"]'); await page.locator('#game[data-phase="summary"]').waitFor(); await check();
      assert.deepEqual(errors, []); console.log(`PASS tutorial ${view.name}`);
    } finally { await context.close(); }
  }
}
async function layoutSweep(browser: Browser): Promise<void> {
  const failures: { size: string; message: string; failures: unknown }[] = [];
  await writeFile(resolve(output, 'layout-failures.json'), '[]\n');
  for (const view of layoutSizes) {
    const { context, page, errors } = await openPage(browser, view, 4n);
    try {
      await audioControls(page, view);
      await fits(page, view.name);
      if (view.width >= 1920 && view.height >= 950) {
        const full = await page.locator('#shop .card .art, #shop .card .stat, #shop .card .eff').evaluateAll(nodes =>
          nodes.filter(n => n.getClientRects().length && getComputedStyle(n).display !== 'none').length);
        assert.equal(full, 12, `${view.name}: roomy shop lost its artwork, colored effects or descriptions`);
      }
      await move(page, view, newRun(4n, 'practice'), { type: 'buy', slot: 1n, cell: 0n });
      await activate(page, view, '[data-cell="0"]'); await visibleBuild(page, view); await shot(page, view.name, 'inspector');
      await closeInspector(page, view);
      await battle(page, view, newRun(4n, 'practice'), [{ type: 'buy', slot: 1n, cell: 0n }], `${view.name}-w1`);
      // Reach a real result at every sweep size. No browser-only state injection.
      let state = playTurn(newRun(4n, 'practice'), [{ type: 'buy', slot: 1n, cell: 0n }]).state;
      while (true) {
        await activate(page, view, '[data-command="continue-summary"]');
        await page.locator(`#game[data-phase="${state.done ? 'end' : 'build'}"]`).waitFor();
        if (state.done) break;
        assert(state.wave < 10n, `${view.name}: sweep exceeded ten waves`);
        await battle(page, view, state, [], `${view.name}-end-path-${state.wave + 1n}`);
        state = playTurn(state, []).state;
      }
      await shot(page, view.name, 'end');
      assert.deepEqual(errors, [], `${view.name}: browser errors`);
      console.log(`PASS layout ${view.name}`);
    } catch (error) {
      await page.screenshot({ path: resolve(output, `${view.name}-layout-failure.png`) });
      const e = error as Error & { actual?: unknown };
      failures.push({ size: view.name, message: e.message.split('\n')[0], failures: e.actual });
      await writeFile(resolve(output, 'layout-failures.json'), JSON.stringify(failures, null, 2));
      console.log(`FAIL layout ${view.name}: ${failures.at(-1)!.message}`);
    } finally { await context.close(); }
  }
  assert.deepEqual(failures, [], 'Layout sweep failures');
}
/** Replay a real crowded wave at every size without injecting browser state. */
async function crowdedSweep(browser: Browser, fourGroups = false): Promise<void> {
  const setup = viewports.find(v => v.touch)!, turns = plan(13n);
  assert.equal(turns.length, 10, 'Crowded sweep requires the complete seed-13 run');
  const { context, page, errors } = await openPage(browser, setup, 13n);
  try {
    for (const turn of turns) {
      let state = turn.start;
      for (const action of turn.actions) state = await move(page, setup, state, action);
      await closeInspector(page, setup);
      await activate(page, setup, '[data-command="fight"]');
      await activate(page, setup, '[data-command="skip"]');
      await page.locator('#game[data-phase="summary"]').waitFor();
      await activate(page, setup, '[data-command="continue-summary"]');
      await page.locator(`#game[data-phase="${turn.end.done ? 'end' : 'build'}"]`).waitFor();
    }
    const turn = turns[9];
    const actions: Action[] = fourGroups ? [{ type: 'sell', cell: 1n }, { type: 'upgrade', cell: 2n }, { type: 'upgrade', cell: 2n }, { type: 'buy', slot: 3n, cell: 3n }] : turn.actions;
    if (fourGroups) {
      const packed = playTurn(turn.start, actions).frames.find(f => f.tick === 5n)!;
      assert.equal(packed.groups.filter(g => g.lane === 0n && g.pos === 4n && g.status === 'active').length, 4, 'Four-group fixture lost its crowd');
      assert(packed.disabled & (1n << 3n), 'Four-group fixture must include its trampled Forge');
    }
    for (const view of layoutSizes) {
      await page.setViewportSize({ width: view.width, height: view.height });
      await activate(page, view, '[data-recap-wave="9"]');
      await page.locator('#game[data-phase="build"][data-practice="true"]').waitFor();
      let state = turn.start;
      for (const action of actions) state = await move(page, view, state, action);
      await battle(page, view, turn.start, actions, `${view.name}-${fourGroups ? 'four-group' : 'crowded'}-w10`, false);
      await activate(page, view, '[data-command="continue-summary"]');
      await page.locator('#game[data-phase="end"][data-practice="true"]').waitFor();
      await activate(page, view, '[data-command="return-result"]');
      console.log(`PASS ${fourGroups ? 'four-group' : 'crowded'} wave 10 ${view.name}`);
    }
    assert.deepEqual(errors, [], 'Crowded sweep browser errors');
  } finally { await context.close(); }
}
async function run(browser: Browser, view: Viewport, seed: bigint, turns: Turn[]): Promise<void> {
  const { context, page, errors } = await openPage(browser, view, seed);
  try {
    for (const [i, turn] of turns.entries()) {
      let state = turn.start;
      for (const a of turn.actions) state = await move(page, view, state, a);
      await battle(page, view, turn.start, turn.actions, `${view.name}-seed${seed}-w${i + 1}`);
      await activate(page, view, '[data-command="continue-summary"]');
      await page.locator(`#game[data-phase="${turn.end.done ? 'end' : 'build'}"]`).waitFor();
      await hud(page, turn.end, 'Turn resolved'); coverage.add(`${view.name}:next-wave`);
    }
    const end = turns.at(-1)!.end;
    assert.equal((await page.locator('.score-total strong').innerText()).trim(), String(end.score));
    assert.deepEqual(await page.locator('.score-card .receipt .r:not(.total) b').allTextContents(), scoreRows(end).map(row => `${row.points} pts`), 'End score points differ from sim');
    const endActions = await page.locator('#action-bar .btn-go, .end-secondary .btn').evaluateAll(nodes => nodes.filter(n => n.getBoundingClientRect().width > 0).map(n => {
      const r = n.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { command: n.getAttribute('data-command'), inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, hit: !!hit && (hit === n || n.contains(hit)) };
    }));
    assert(endActions.every(a => a.inside && a.hit), `End actions clipped or covered: ${JSON.stringify(endActions)}`);
    await shot(page, `${view.name}-seed${seed}`, 'end');
    if (seed === seeds[0]) await practiceReplan(page, view, turns, `${view.name}-seed${seed}`);
    assert.deepEqual(errors, [], 'Browser errors');
    results.push({ viewport: view.name, seed: String(seed), waves: String(end.wave), walls: String(end.walls), gold: String(end.gold), score: String(end.score) });
    console.log(`PASS ${view.name} seed ${seed}: ${end.wave} waves, ${end.walls} walls, ${end.gold}g, score ${end.score}`);
  } catch (error) { await page.screenshot({ path: resolve(output, `${view.name}-seed${seed}-failure.png`) }); throw error; }
  finally { await context.close(); }
}

async function leakBaseline(browser: Browser): Promise<void> {
  const view = viewports[0], { context, page } = await openPage(browser, view, 13n);
  const observations: unknown[] = [];
  try {
    for (const turn of plan(13n).slice(0, 7)) {
      for (const action of turn.actions) {
        await page.keyboard.press('Escape');
        if (action.type === 'buy') { await page.locator(`[data-slot="${action.slot + 1n}"]`).click(); await page.locator(`[data-cell="${action.cell}"]`).click(); }
        else if (action.type === 'reroll') await page.locator('[data-command="reroll"]:visible').first().click();
        else { await page.locator(`[data-cell="${action.cell}"]`).click(); await page.locator(`#inspector [data-command="${action.type}"]`).click(); }
      }
      await page.keyboard.press('Escape');
      if (turn.start.wave === 6n) await page.evaluate(() => {
        const records: object[] = [];
        (window as typeof window & { leakProbe: object[] }).leakProbe = records;
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
        Object.defineProperty(Element.prototype, 'innerHTML', { ...desc, set(value: string) {
          if ((this as Element).matches('[data-wall]') && value.includes('Leaked')) records.push({ value, tick: document.querySelector<HTMLElement>('#game')?.dataset.combatTick, stack: new Error().stack });
          desc.set!.call(this, value);
        } });
      });
      await page.locator('[data-command="fight"]').click();
      if (turn.start.wave === 6n) {
        await page.waitForTimeout(1700);
        observations.push(...await page.evaluate(() => (window as typeof window & { leakProbe: object[] }).leakProbe));
        await page.screenshot({ path: resolve(output, 'pl1-rd6-wave7-probe.png') }); break;
      }
      await page.locator('[data-command="skip"]').click(); await page.locator('#game[data-phase="summary"]').waitFor(); await page.locator('[data-command="continue-summary"]').click();
    }
    await writeFile(resolve(root, '.tmp/pl1/rd6-leak-probe.json'), JSON.stringify(observations, null, 2));
    console.log(`Wave 7 before-contact Leaked writes: ${observations.length}`);
    if (!option('--dist')) assert.equal(observations.length, 0, 'Queued groups must never become leaked on impact');
  } finally { await context.close(); }
}
async function polishBaseline(browser: Browser): Promise<void> {
  const samples: { name: string; texts: TextBox[]; labels: ReturnType<typeof combatLabelSnapshot> }[] = [];
  for (const view of [viewports[0], viewports[2]]) {
    const { context, page } = await openPage(browser, view, 4n);
    try {
      if (!view.touch) {
        for (const selector of ['[data-slot="3"]', '[data-cell="2"]', '[data-cell="2"]', '[data-command="upgrade"]', '[data-command="upgrade"]', '[data-command="close-inspector"]', '[data-command="fight"]', '[data-command="skip"]']) await page.locator(selector).first().click();
        await page.locator('#game[data-phase="summary"]').waitFor();
        await page.locator('[data-command="continue-summary"]').click();
        for (const selector of ['[data-cell="2"]', '[data-command="overclock"]', '[data-command="close-inspector"]']) await page.locator(selector).first().click();
      } else {
        await page.locator('[data-command="fight"]').tap(); await page.waitForTimeout(1200);
      }
      const labels = await page.evaluate<ReturnType<typeof combatLabelSnapshot>>(`(${combatLabelSnapshot.toString()})(${auditLabelBoxes.toString()})`);
      samples.push({ name: view.name, texts: await page.evaluate(textSnapshot), labels });
    } finally { await context.close(); }
  }
  await writeFile(resolve(root, '.tmp/pl1/rd6-measurements.json'), JSON.stringify(samples, null, 2));
  const failures = samples.flatMap(s => [...s.labels.failures, ...auditTextBoxes(s.texts)].map(f => `${s.name}: ${f}`));
  console.log(JSON.stringify(failures, null, 2));
  assert.deepEqual(failures, [], 'PL1 checks reject RD6 measured boxes');
}
/** RD10 proof uses real queues and clicks; samples computed size through every frame. */
async function rd10Probe(browser: Browser): Promise<void> {
  const proofDir = resolve(root, '.tmp/rd10/proof'); await mkdir(proofDir, { recursive: true });
  const turns = plan(13n);
  for (const view of (option('--sizes') ? layoutSizes : viewports)) {
    const { context, page, errors, videoStartedAt } = await openPage(browser, view, 13n);
    const pageTimeOrigin = await page.evaluate(() => performance.timeOrigin);
    try {
      for (const [i, turn] of turns.entries()) {
        let state = turn.start;
        for (const action of turn.actions) state = await move(page, view, state, action);
        await closeInspector(page, view);
        if (i === 0) { await fits(page, `${view.name}-RD10-build`); await page.screenshot({ path: resolve(proofDir, `${view.name}-plans.png`) }); }
        if (i !== 4 && i !== 9) {
          await activate(page, view, '[data-command="fight"]'); await activate(page, view, '[data-command="skip"]');
        } else {
          await page.evaluate(() => {
            const win = window as typeof window & { rd10Samples: unknown[]; rd10Sampling: boolean };
            win.rd10Samples = []; win.rd10Sampling = true;
            const sample = () => {
              const game = document.querySelector<HTMLElement>('#game')!;
              win.rd10Samples.push({ at: performance.now(), phase: game.dataset.phase, tick: game.dataset.combatTick, beat: game.dataset.combatPhase, wallLosses: [...document.querySelectorAll('.wall-loss')].map(n => ({ text: n.textContent, rect: n.getBoundingClientRect().toJSON() })),
                groups: [...document.querySelectorAll<HTMLElement>('#board .cell .enemy-group')].map(actor => {
                  const body = actor.querySelector<HTMLElement>('.unit-body[data-front="true"]'), svg = body?.querySelector('svg');
                  return { id: actor.dataset.group, kind: actor.dataset.kind, cell: actor.closest<HTMLElement>('[data-cell]')?.dataset.cell,
                    configured: actor.dataset.bodySize, width: body ? getComputedStyle(body).width : '', height: body ? getComputedStyle(body).height : '', svg: svg?.getBoundingClientRect().toJSON(),
                    chip: actor.querySelector('.foe')?.textContent, cue: actor.querySelector('.group-cue')?.textContent };
                }) });
              if (win.rd10Sampling) requestAnimationFrame(sample);
            }; requestAnimationFrame(sample);
          });
          await activate(page, view, '[data-command="fight"]');
          const captures = i === 4 ? [{ tick: '4', beat: 'Hit' }, { tick: '8', beat: 'Bite' }] : [4,5,6,7].map(tick => ({ tick: String(tick), beat: 'Hit' }));
          for (const capture of captures) {
            await page.waitForFunction(({ tick, beat }) => {
              const g = document.querySelector<HTMLElement>('#game')!;
              return g.dataset.combatTick === tick && g.dataset.combatPhase === beat;
            }, capture, { timeout: 30000 });
            await page.screenshot({ path: resolve(proofDir, `${view.name}-w${i+1}-t${capture.tick}.png`) });
            if (i === 4 && capture.tick === '8') {
              // Bite, break, Move and ordinary leak: cadence recorded alongside screenshots.
              const sequenceStart = Date.now(), cadence: number[] = [];
              await writeFile(resolve(proofDir, `${view.name}-w5-video-window.json`), JSON.stringify({ start: Math.max(0, (sequenceStart - videoStartedAt) / 1000 - .4), duration: 6, videoStartedAt, pageTimeOrigin }));
              for (let frame = 0; frame < 28; frame++) {
                await page.waitForTimeout(Math.max(0, sequenceStart + (frame + 1) * 80 - Date.now()));
                cadence.push(Date.now() - sequenceStart);
                await page.screenshot({ path: resolve(proofDir, `${view.name}-w5-break-${String(frame).padStart(2,'0')}.png`) });
              }
              await writeFile(resolve(proofDir, `${view.name}-w5-cadence.json`), JSON.stringify(cadence));
            }
          }
          await page.locator('#game[data-phase="summary"]').waitFor({ timeout: 30000 });
          const samples = await page.evaluate(() => { const win = window as typeof window & { rd10Samples: unknown[]; rd10Sampling: boolean }; win.rd10Sampling = false; return win.rd10Samples; });
          await writeFile(resolve(proofDir, `${view.name}-w${i+1}-frames.json`), JSON.stringify(samples, null, 2));
          if (i === 4) {
            for (const id of ['5','13']) {
              const rows = (samples as { tick: string; groups: {id: string; configured: string; width: string; height: string; cell: string}[] }[])
                .filter(s => Number(s.tick) >= 3 && Number(s.tick) <= 8).flatMap(s => s.groups.filter(g => g.id === id));
              assert(rows.length > 100, `Missing W5 group ${id} frames`);
              assert.equal(new Set(rows.map(g => g.configured)).size, 1, 'Body size changed in a shared cell');
              assert(rows.every(g => g.width === `${g.configured}px` && g.height === `${g.configured}px`));
              assert(new Set(rows.map(g => g.cell)).size >= 2, 'Probe missed entry into a shared cell');
            }
          }
          console.log(`RD10 frames ${view.name} W${i+1}: ${samples.length}`);
        }
        await page.locator('#game[data-phase="summary"]').waitFor({ timeout: 30000 });
        await activate(page, view, '[data-command="continue-summary"]');
        await page.locator(`#game[data-phase="${i===9?'end':'build'}"]`).waitFor();
      }
      const saved = await page.evaluate(() => JSON.stringify(localStorage));
      await page.screenshot({ path: resolve(proofDir, `${view.name}-end.png`) });
      await activate(page, view, '[data-recap-wave="2"]');
      await page.locator('#game[data-phase="build"][data-practice="true"]').waitFor();
      await page.screenshot({ path: resolve(proofDir, `${view.name}-replan-w3.png`) });
      await activate(page, view, '[data-command="fight"]'); await activate(page, view, '[data-command="skip"]');
      await page.locator('#game[data-phase="summary"]').waitFor(); await activate(page, view, '[data-command="continue-summary"]');
      await page.locator('#game[data-phase="end"]').waitFor();
      await page.screenshot({ path: resolve(proofDir, `${view.name}-branch-curves.png`) });
      assert.equal(await page.locator('.branch-curve').count(), 2);
      assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), saved, 'RD10 branch changed best score');
      await fits(page, `${view.name}-RD10-branch`);
      assert.deepEqual(errors, []);
    } finally {
      const movie = page.video(); await context.close();
      if (movie) await movie.saveAs(resolve(proofDir, `${view.name}-rd10.webm`));
    }
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? resolve(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell'),
  headless: true, args: ['--no-sandbox'],
});
try {
  if (args.includes('--deploy-check')) { const { deploySmoke } = await import('./deploy-smoke.js'); await deploySmoke(browser, dist, textFits); }
  else if (args.includes('--rd10-probe')) { await rd10Probe(browser); }
  else if (args.includes('--leak-baseline')) { await leakBaseline(browser); }
  else if (args.includes('--polish-baseline')) { await polishBaseline(browser); process.exitCode = 0; }
  else if (args.includes('--layout-only')) { await layoutSweep(browser); }
  else if (args.includes('--tutorial-only')) { await tutorialSweep(browser); }
  else if (args.includes('--crowded-only')) { await crowdedSweep(browser); }
  else if (args.includes('--four-only')) { await crowdedSweep(browser, true); }
  else if (args.includes('--play-only')) { const plans = seeds.map(plan); for (const view of (option('--sizes') ? layoutSizes : viewports).filter(v => !option('--views') || option('--views')!.split(',').includes(v.name))) for (const [i, seed] of seeds.entries()) await run(browser, view, seed, plans[i]); }
  else if (args.includes('--later-tutorials')) { await laterTutorials(browser); }
  else if (args.includes('--regressions-only')) { for (const view of viewports.filter(v => !option('--views') || option('--views')!.split(',').includes(v.name))) await regressions(browser, view); }
  else {
  for (const view of viewports) await teachingChecks(browser, view);
  await sixOrders(browser); await laterTutorials(browser); await tutorialSweep(browser); await layoutSweep(browser); await crowdedSweep(browser); await crowdedSweep(browser, true);
  const plans = seeds.map(seed => { console.log(`Planning seed ${seed}`); return plan(seed); });
  for (const view of viewports) {
    await regressions(browser, view);
    for (const [i, seed] of seeds.entries()) await run(browser, view, seed, plans[i]);
    for (const action of ['buy', 'upgrade', 'sell', 'overclock', 'reroll', 'next-wave', 'replan']) assert(coverage.has(`${view.name}:${action}`), `${view.name}: missing ${action}`);
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ seeds: seeds.map(String), coverage: [...coverage], layoutSizes, results }, null, 2) + '\n');
  console.log(`Smoke passed: ${seeds.length} seeds × ${viewports.length} viewports + ${layoutSizes.length} layout sizes. Screenshots: .tmp/smoke/`);
  }
} finally { await browser.close(); }
