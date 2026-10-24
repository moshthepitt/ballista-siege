import { describe, expect, it } from 'vitest';
import { audioMetrics, encodeWav, printAudioMetrics } from '../../scripts/audio-metrics.js';

describe('offline render measurements', () => {
  it('prints peak and per-second RMS for a synthetic stereo sine and partial final second', () => {
    const rate = 8000, sine = Float32Array.from({ length: rate * 2.5 }, (_, i) => i < rate * 2 ? .5 * Math.sin(2 * Math.PI * 1000 * i / rate) : 0);
    const metrics = audioMetrics([sine, sine], rate);
    expect(metrics.peakDbfs).toBeCloseTo(-6.0206, 3);
    expect(metrics.seconds.map(s => s.second)).toEqual([0, 1, 2]);
    expect(metrics.seconds[0]!.rmsDbfs).toBeCloseTo(-9.0309, 3);
    expect(metrics.seconds[2]!.rmsDbfs).toBe(-Infinity);
    expect(printAudioMetrics(metrics)).toBe('Peak: -6.02 dBFS\nSecond  Peak dBFS  RMS dBFS  RMS\n     0      -6.02     -9.03  0.353553\n     1      -6.02     -9.03  0.353553\n     2       -inf      -inf  0.000000');
  });
  it('encodes interleaved signed PCM with a valid WAV header', () => {
    const wav = encodeWav([[0, .5, -1], [1, -.5, 0]], 48000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF'); expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect(wav.readUInt32LE(40)).toBe(12); expect(wav.readUInt16LE(22)).toBe(2); expect(wav.readUInt32LE(24)).toBe(48000);
    expect(Array.from({ length: 6 }, (_, i) => wav.readInt16LE(44 + i * 2))).toEqual([0, 32767, 16384, -16384, -32768, 0]);
  });
  it('rejects clipped, damaged or mismatched buffers', () => {
    expect(() => encodeWav([[1.1]], 48000)).toThrow('clip');
    expect(() => audioMetrics([[NaN]], 48000)).toThrow('Non-finite');
    expect(() => audioMetrics([[1], []], 48000)).toThrow('equal');
  });
});
