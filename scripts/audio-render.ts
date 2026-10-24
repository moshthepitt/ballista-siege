import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build } from 'vite';
import { audioMetrics, encodeWav, printAudioMetrics } from './audio-metrics.js';

// Run outside the sandbox: node --import tsx scripts/audio-render.ts [--wave=5] [--out=.tmp/audio]
// CHROMIUM_PATH overrides the same headless-shell default used by EYES.
const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const wave = Number(arg('wave') ?? 5);
assert(Number.isInteger(wave) && wave >= 1 && wave <= 10, '--wave must be 1-10');
const out = resolve(root, arg('out') ?? '.tmp/audio'); await mkdir(out, { recursive: true });
const recording = JSON.parse(await readFile(resolve(root, 'play/audio/fixtures/seed13.json'), 'utf8'))[wave - 1];
const bundle = await build({ configFile: false, root, logLevel: 'warn', build: { write: false, minify: true,
  lib: { entry: resolve(root, 'play/audio/offline.ts'), formats: ['es'], fileName: 'audio-render' } } });
const output = Array.isArray(bundle) ? bundle.flatMap(result => result.output) : 'output' in bundle ? bundle.output : [];
const code = output.find(item => item.type === 'chunk' && item.isEntry);
assert(code?.type === 'chunk');
const executablePath = process.env.CHROMIUM_PATH ?? resolve(homedir(), '.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell');
const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  await page.addInitScript('window.__name = (fn) => fn');
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('http://audio.test/**', route => route.fulfill({ contentType: route.request().url().endsWith('.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().endsWith('.js') ? code.code : '<!doctype html><title>Battle audio render</title>' }));
  await page.goto('http://audio.test/');
  const result = await page.evaluate(async data => {
    const entry = '/audio-render.js';
    const { renderBattleAudio } = await import(entry);
    return await renderBattleAudio(data) as { channels: number[][]; sampleRate: number; duration: number; events: number };
  }, JSON.stringify(recording));
  assert.deepEqual(errors, [], 'Browser errors during offline render');
  const metrics = audioMetrics(result.channels, result.sampleRate);
  console.log(`Seed 13 · wave ${wave} · 1× · ${result.duration.toFixed(3)}s · ${result.events} effect cues`);
  console.log(printAudioMetrics(metrics));
  await writeFile(resolve(out, `w${wave}.wav`), encodeWav(result.channels, result.sampleRate));
  await writeFile(resolve(out, `w${wave}-metrics.json`), JSON.stringify({ ...metrics, duration: result.duration, events: result.events }, null, 2) + '\n');
  console.log(resolve(out, `w${wave}.wav`));
  assert(metrics.peakDbfs < -1, `Peak must stay below -1 dBFS; got ${metrics.peakDbfs.toFixed(2)}`);
  assert(metrics.peak > 0, 'Offline render was silent');
} finally { await browser.close(); }
