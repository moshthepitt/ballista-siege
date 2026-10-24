// Print the sound and music cues of one recorded seed-13 battle, as the offline render plays them.
// usage: node --import tsx scripts/audio-cues.ts [--wave=5]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { battleTrack } from '../play/audio/track.js';
import { makeTimeline } from '../play/replay.js';
import type { RunState, TickFrame } from '../src/v1/sim.js';

const wave = Number(process.argv.find(a => a.startsWith('--wave='))?.slice(7) ?? 5);
const fixture = fileURLToPath(new URL('../play/audio/fixtures/seed13.json', import.meta.url));
const recording = JSON.parse(readFileSync(fixture, 'utf8'))[wave - 1];
const { built, frames } = JSON.parse(JSON.stringify(recording), (_key, value) =>
  typeof value === 'string' && /^\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value) as { built: RunState; frames: TickFrame[] };
const track = battleTrack(makeTimeline(built, frames), built.wave + 1n);

// Music events repeat every scheduling step; print only changes.
let music = '';
for (const event of track.events) {
  const at = `${(event.at / 1000).toFixed(2).padStart(6)}s`;
  if (event.type === 'sound') {
    const { lane, intensity } = event.options;
    console.log(`${at}  ${event.kind}${lane === undefined ? '' : ` lane ${Number(lane) + 1}`}${intensity === undefined ? '' : ` intensity ${Number(intensity).toFixed(2)}`}`);
  } else {
    const next = `music phase=${event.phase} intensity=${event.intensity} bar=${event.tickMs}ms`;
    if (next !== music) console.log(`${at}  ${next}`);
    music = next;
  }
}
console.log(`${(track.duration / 1000).toFixed(2).padStart(6)}s  end`);
