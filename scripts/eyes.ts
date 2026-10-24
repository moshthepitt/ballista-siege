// Screenshot queue for sandboxed agents that cannot launch a browser.
//
// The orchestrator runs `pnpm eyes` outside the sandbox. An agent writes a request to
// .tmp/eyes/req/<id>.json and waits for .tmp/eyes/out/<id>/done.json. Results:
// PNG screenshots, a text-overflow audit, page errors and (optionally) smoke-test output.
//
// Request fields (all optional):
//   query  "?seed=13&mode=practice&backend=local"  page URL query
//   sizes  [[1920, 950], [390, 844]]               viewports; width < 600 uses touch
//   steps  [{ "click": "[data-slot=\"1\"]" }, { "key": "Space" }, { "wait": 800 },
//           { "waitFor": "#game[data-phase=build]" }, { "hover": ".card" }, { "shot": "picked" }]
//          A screenshot named "start" is always taken after load; add { "shot": name } for more.
//   audit  true                                   list elements whose text overflows its box
//   storage { "key": "value" }                    localStorage before startup (fresh profile otherwise)
//   network true                                 record network requests and board interactivity
//   smoke  "--seeds=4"                             also run the smoke test with these args
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = resolve(root, '.tmp/eyes');
const reqDir = resolve(base, 'req'), outDir = resolve(base, 'out'), dist = resolve(base, 'dist');
const exe = process.env.CHROMIUM_PATH ?? resolve(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell');
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };

type Step = { click?: string; hover?: string; key?: string; wait?: number; waitFor?: string; shot?: string };
type Request = { query?: string; sizes?: [number, number][]; steps?: Step[]; audit?: boolean; smoke?: string; storage?: Record<string, string>; network?: boolean };

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise(done => {
    const child = spawn(cmd, args, { cwd: root, env: process.env });
    let out = '';
    const keep = (b: Buffer) => { out = (out + b.toString()).slice(-40000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', code => { clearTimeout(timer); done({ code, out }); });
  });
}

// Runs inside the page. Elements with their own text that overflow or leave their parent box.
function overflowAudit(): string[] {
  const out: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('#game *')) {
    if (el.closest('svg, .sr-only')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY)) continue;
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim())) continue;
    const label = `${el.tagName.toLowerCase()}${el.classList.length ? '.' + [...el.classList].join('.') : ''} "${el.textContent!.trim().slice(0, 50)}"`;
    if (el.scrollWidth - el.clientWidth > 1) out.push(`${label} wider than its box (${el.scrollWidth} > ${el.clientWidth})`);
    if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth) out.push(`${label} cut by ellipsis`);
    const parent = el.parentElement;
    if (parent && parent.id !== 'game' && cs.position === 'static') {
      const r = el.getBoundingClientRect(), p = parent.getBoundingClientRect();
      if (r.right > p.right + 1 || r.left < p.left - 1 || r.bottom > p.bottom + 1 || r.top < p.top - 1) out.push(`${label} leaves its parent box`);
    }
  }
  return [...new Set(out)];
}

async function serve(page: Page): Promise<void> {
  await page.route('https://**/*', route => route.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('http://localhost/**', async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const path = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!path.startsWith(`${dist}${sep}`) || !existsSync(path)) { await route.fulfill({ status: 404, body: '' }); return; }
    await route.fulfill({ contentType: mime[extname(path)] ?? 'application/octet-stream', body: await readFile(path) });
  });
}

async function handle(id: string, req: Request): Promise<void> {
  const out = resolve(outDir, id);
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  const report: Record<string, unknown> = { id, shots: [] as string[], audit: {} as Record<string, string[]>, errors: [] as string[] };
  const build = await run('pnpm', ['exec', 'vite', 'build', 'play', '--outDir', dist, '--emptyOutDir'], 180000);
  report.build = { code: build.code, tail: build.code ? build.out.slice(-3000) : 'ok' };
  if (build.code === 0) {
    const browser = await chromium.launch({ executablePath: exe });
    try {
      for (const [w, h] of req.sizes ?? [[1920, 950], [1366, 650], [390, 844]]) {
        const touch = w < 600;
        const context = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
        const page = await context.newPage();
        await page.addInitScript('window.__name = (fn) => fn');
        if (req.storage) await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, req.storage);
        if (req.network) {
          const requests: unknown[] = [];
          ((report.network ??= {}) as Record<string, unknown>)[`${w}x${h}`] = requests;
          page.on('request', request => { void page.evaluate(() => ({ phase: document.querySelector('#game')?.getAttribute('data-phase'), enabled: !!document.querySelector('[data-command=fight]:not([disabled])') })).then(board => requests.push({ url: request.url(), board })).catch(() => requests.push({ url: request.url() })); });
        }
        page.on('pageerror', e => (report.errors as string[]).push(`${w}x${h}: ${e.message}`));
        page.on('console', m => { if (m.type() === 'error') (report.errors as string[]).push(`${w}x${h}: ${m.text()}`); });
        await serve(page);
        const tag = `${w}x${h}`;
        const shot = async (name: string) => {
          const file = resolve(out, `${tag}-${String((report.shots as string[]).length).padStart(2, '0')}-${name}.png`);
          await page.screenshot({ path: file }); (report.shots as string[]).push(file);
          if (req.audit) (report.audit as Record<string, string[]>)[`${tag} ${name}`] = await page.evaluate(overflowAudit);
        };
        try {
          await page.goto(`http://localhost/${req.query ?? '?seed=13&mode=practice&backend=local'}`, { waitUntil: 'load', timeout: 20000 });
          await page.waitForTimeout(900);
          await shot('start');
          for (const step of req.steps ?? []) {
            if (step.click) { const l = page.locator(step.click).first(); if (touch) await l.tap({ timeout: 5000 }); else await l.click({ timeout: 5000 }); await page.waitForTimeout(250); }
            if (step.hover) { await page.locator(step.hover).first().hover({ timeout: 5000 }); await page.waitForTimeout(250); }
            if (step.key) { await page.keyboard.press(step.key); await page.waitForTimeout(250); }
            if (step.waitFor) await page.locator(step.waitFor).first().waitFor({ timeout: 30000 });
            if (step.wait) await page.waitForTimeout(Math.min(step.wait, 30000));
            if (step.shot) await shot(step.shot);
          }
        } catch (e) { (report.errors as string[]).push(`${tag}: step failed: ${(e as Error).message.split('\n')[0]}`); await shot('failed').catch(() => {}); }
        await context.close();
      }
    } finally { await browser.close(); }
  }
  if (req.smoke !== undefined) {
    // Smoke serves play/dist, so build it from the current sources first.
    const built = await run('pnpm', ['exec', 'vite', 'build', 'play'], 180000);
    const smoke = built.code ? built : await run('node', ['--import', 'tsx', 'scripts/play-smoke.ts', ...req.smoke.split(' ').filter(Boolean)], 3000000);
    report.smoke = { code: smoke.code, tail: smoke.out.slice(-6000) };
  }
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(out, 'done.json'), JSON.stringify({ id, ok: build.code === 0, at: new Date().toISOString() }));
  console.log(`eyes: ${id} done (${(report.shots as string[]).length} shots, ${(report.errors as string[]).length} errors)`);
}

await mkdir(reqDir, { recursive: true }); await mkdir(outDir, { recursive: true });
console.log(`eyes: watching ${reqDir}`);
for (;;) {
  for (const name of (await readdir(reqDir)).filter(n => n.endsWith('.json')).sort()) {
    const id = name.replace(/\.json$/, '').replace(/[^\w.-]/g, '_');
    const claimed = resolve(reqDir, `${name}.taken`);
    await rename(resolve(reqDir, name), claimed).catch(() => null);
    let req: Request = {};
    try { req = JSON.parse(await readFile(claimed, 'utf8')); } catch (e) { req = {}; console.log(`eyes: ${id} bad json, using defaults: ${(e as Error).message}`); }
    await handle(id, req).catch(async e => {
      await mkdir(resolve(outDir, id), { recursive: true });
      await writeFile(resolve(outDir, id, 'done.json'), JSON.stringify({ id, ok: false, error: String(e) }));
    });
    await rm(claimed, { force: true });
  }
  await new Promise(r => setTimeout(r, 1000));
}
