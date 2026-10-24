import type { VoiceGraph } from './engine.js';

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseBuffer(context: BaseAudioContext): AudioBuffer {
  let buffer = noiseBuffers.get(context);
  if (!buffer) {
    buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const samples = buffer.getChannelData(0);
    let seed = 0x51e9e;
    for (let i = 0; i < samples.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      samples[i] = (seed >>> 0) / 0x80000000 - 1;
    }
    noiseBuffers.set(context, buffer);
  }
  return buffer;
}

/** Relative times and frequencies let an entire effect share one pitch/length variation. */
export class Synth {
  constructor(readonly graph: VoiceGraph, readonly pitch = 1, readonly length = 1) {}
  private envelope(duration: number, level: number, delay: number, attack: number, hold = 0): GainNode {
    const { context, output, at, node } = this.graph;
    const gain = node(context.createGain());
    const start = at + delay * this.length, end = start + duration * this.length;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + Math.min(attack * this.length, (end - start) * 0.4));
    if (hold) gain.gain.setValueAtTime(level, start + Math.min((attack + hold) * this.length, (end - start) * 0.85));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    gain.connect(output);
    return gain;
  }
  tone(type: OscillatorType, frequency: number, endFrequency: number, duration: number, level: number, delay = 0, attack = 0.003, hold = 0, cutoff = 0): void {
    const { context, at, node, source } = this.graph;
    const oscillator = node(context.createOscillator()); oscillator.type = type;
    const start = at + delay * this.length, end = start + duration * this.length;
    oscillator.frequency.setValueAtTime(frequency * this.pitch, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency * this.pitch), end);
    const envelope = this.envelope(duration, level, delay, attack, hold);
    if (cutoff) {
      const filter = node(context.createBiquadFilter()); filter.type = 'lowpass';
      filter.frequency.value = cutoff; filter.Q.value = 0.7;
      oscillator.connect(filter).connect(envelope);
    } else oscillator.connect(envelope);
    source(oscillator, start, end);
  }
  noise(frequency: number, endFrequency: number, duration: number, level: number, delay = 0, type: BiquadFilterType = 'lowpass', attack = 0.004, q = 0.8): void {
    const { context, at, node, source } = this.graph;
    const noise = node(context.createBufferSource()); noise.buffer = noiseBuffer(context); noise.loop = true;
    const filter = node(context.createBiquadFilter()); filter.type = type; filter.Q.value = q;
    const start = at + delay * this.length, end = start + duration * this.length;
    filter.frequency.setValueAtTime(frequency * this.pitch, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency * this.pitch), end);
    noise.connect(filter).connect(this.envelope(duration, level, delay, attack));
    source(noise, start, end);
  }
  chord(notes: readonly number[], duration: number, level: number, spacing = 0.06): void {
    notes.forEach((note, i) => this.tone('sine', note, note * 0.997, duration, level / Math.sqrt(notes.length), i * spacing, 0.01));
  }
}
