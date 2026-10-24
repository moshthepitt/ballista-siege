// Listening queue for sandboxed agents that cannot launch a browser or reach the network.
//
// The orchestrator runs `pnpm ears` outside the sandbox. An agent writes a request to
// .tmp/ears/req/<id>.json and waits for .tmp/ears/out/<id>/done.json. For each request, ears
// renders one recorded seed-13 battle offline (scripts/audio-render.ts) and prints its cue list
// (scripts/audio-cues.ts). With "listen", Gemini hears the WAV and writes a critique.
//
// Request fields (all optional):
//   wave    5                       recorded seed-13 wave, 1-10 (5 and 10 are boss waves)
//   listen  true                    three independent Gemini listens; report.json holds each score
//                                   and the median. At most 8 listen requests per ears run.
//   focus   "Is the storm horn..."  extra questions appended to the listening prompt
// Results in .tmp/ears/out/<id>/: w<wave>.wav, w<wave>-metrics.json, render.txt (peak and RMS
// per second), cues.txt, gemini-1..3.md (if listened), report.json.
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = resolve(root, '.tmp/ears');
const reqDir = resolve(base, 'req'), outDir = resolve(base, 'out');
const maxListens = 8, listeners = 3;
let listens = 0;

type Request = { wave?: number; listen?: boolean; focus?: string };

function run(args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise(done => {
    const child = spawn('node', args, { cwd: root, env: process.env });
    let out = '';
    const keep = (b: Buffer) => { out = (out + b.toString()).slice(-40000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', code => { clearTimeout(timer); done({ code, out }); });
  });
}

async function prompt(wave: number, render: string, cues: string, focus: string | undefined): Promise<string> {
  const design = await readFile(resolve(root, '.tmp/design/audio.md'), 'utf8').catch(() => '');
  return `You are judging the audio of a small browser tower-defense game, "Ballista Siege". All sound is synthesized at runtime with the Web Audio API (no samples). The attached WAV is one full battle (wave ${wave} of 10${wave === 5 || wave === 10 ? ', a boss wave' : ''}) rendered offline at 1x speed: effects plus adaptive music. The cue list says what the game asked for and when; lanes 1-4 pan left to right.

Answer in this order, plain prose, short:
1. Timeline: for each cue (group simultaneous ones), can you hear it at that time, and does it sound like its intended description? Flag any you cannot hear or cannot tell apart.
2. Mix: loudness for a game, music vs effects balance, panning, harshness or clicks, fatigue over 10 waves.
3. Music: does it follow the fight (boss mood, rising intensity, bars locked to ticks)? Pleasant? Audible looping?
4. The 5 most valuable changes, each concrete (which sound, which parameter, which direction, how much).
5. Scores 1-10, then one JSON line: {"effects": n, "music": n, "mix": n}
${focus ? `\nAlso answer: ${focus}\n` : ''}
DESIGN INTENT
${design}

RENDER METRICS
${render}

CUE LIST
${cues}`;
}

async function handle(id: string, req: Request): Promise<void> {
  const out = resolve(outDir, id);
  await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
  const wave = Number.isInteger(req.wave) && req.wave! >= 1 && req.wave! <= 10 ? req.wave! : 5;
  const report: Record<string, unknown> = { id, wave };
  const render = await run(['--import', 'tsx', 'scripts/audio-render.ts', `--wave=${wave}`, `--out=${out}`], 600000);
  const cues = await run(['--import', 'tsx', 'scripts/audio-cues.ts', `--wave=${wave}`], 120000);
  await writeFile(resolve(out, 'render.txt'), render.out); await writeFile(resolve(out, 'cues.txt'), cues.out);
  report.render = { code: render.code, tail: render.out.slice(-3000) };
  report.cues = { code: cues.code };
  if (req.listen && render.code === 0 && cues.code === 0) {
    if (listens >= maxListens) report.listen = `refused: ${maxListens} listens already used this run`;
    else {
      listens++;
      await writeFile(resolve(out, 'prompt.md'), await prompt(wave, render.out, cues.out, req.focus));
      // One listen varies by a point or two, so judge by the median of three.
      const runs = await Promise.all(Array.from({ length: listeners }, (_, i) =>
        run(['.tmp/agents/gemini.mjs', resolve(out, 'prompt.md'), resolve(out, `gemini-${i + 1}.md`), resolve(out, `w${wave}.wav`)], 900000)));
      const scores: Record<string, number>[] = [];
      for (let i = 0; i < listeners; i++) {
        const text = await readFile(resolve(out, `gemini-${i + 1}.md`), 'utf8').catch(() => '');
        const json = text.match(/\{\s*"effects"[^}]*\}/g)?.at(-1);
        if (json) try { scores.push(JSON.parse(json)); } catch { /* unparsable answer: left out of the median */ }
      }
      const median = (key: string) => { const v = scores.map(s => s[key]!).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
      report.listen = { codes: runs.map(r => r.code), scores, median: { effects: median('effects'), music: median('music'), mix: median('mix') }, listensLeft: maxListens - listens };
    }
  }
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(out, 'done.json'), JSON.stringify({ id, ok: render.code === 0, at: new Date().toISOString() }));
  console.log(`ears: ${id} done (render ${render.code}, listen ${req.listen ? 'yes' : 'no'})`);
}

await mkdir(reqDir, { recursive: true }); await mkdir(outDir, { recursive: true });
console.log(`ears: watching ${reqDir}`);
for (;;) {
  for (const name of (await readdir(reqDir)).filter(n => n.endsWith('.json')).sort()) {
    const id = name.replace(/\.json$/, '').replace(/[^\w.-]/g, '_');
    const claimed = resolve(reqDir, `${name}.taken`);
    await rename(resolve(reqDir, name), claimed).catch(() => null);
    let req: Request = {};
    try { req = JSON.parse(await readFile(claimed, 'utf8')); } catch (e) { console.log(`ears: ${id} bad json, using defaults: ${(e as Error).message}`); }
    await handle(id, req).catch(async e => {
      await mkdir(resolve(outDir, id), { recursive: true });
      await writeFile(resolve(outDir, id, 'done.json'), JSON.stringify({ id, ok: false, error: String(e) }));
    });
    await rm(claimed, { force: true });
  }
  await new Promise(r => setTimeout(r, 1000));
}
