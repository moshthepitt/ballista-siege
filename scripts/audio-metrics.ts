export const dbfs = (amplitude: number): number => amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
export function audioMetrics(channels: readonly ArrayLike<number>[], sampleRate: number) {
  if (!channels.length || sampleRate <= 0 || !Number.isInteger(sampleRate)) throw new Error('Audio needs channels and a positive sample rate');
  const length = channels[0]!.length;
  if (channels.some(c => c.length !== length)) throw new Error('Audio channels must have equal lengths');
  let peak = 0;
  const seconds: { second: number; rms: number; rmsDbfs: number; peakDbfs: number }[] = [];
  for (let start = 0; start < length; start += sampleRate) {
    const end = Math.min(length, start + sampleRate);
    let squares = 0, localPeak = 0;
    for (const channel of channels) for (let i = start; i < end; i++) {
      const v = channel[i]!;
      if (!Number.isFinite(v)) throw new Error('Non-finite audio sample');
      localPeak = Math.max(localPeak, Math.abs(v)); squares += v * v;
    }
    peak = Math.max(peak, localPeak);
    const rms = Math.sqrt(squares / ((end - start) * channels.length));
    seconds.push({ second: start / sampleRate, rms, rmsDbfs: dbfs(rms), peakDbfs: dbfs(localPeak) });
  }
  return { peak, peakDbfs: dbfs(peak), seconds };
}
const printDb = (value: number) => Number.isFinite(value) ? value.toFixed(2) : '-inf';
export function printAudioMetrics(metrics: ReturnType<typeof audioMetrics>): string {
  return [`Peak: ${printDb(metrics.peakDbfs)} dBFS`, 'Second  Peak dBFS  RMS dBFS  RMS',
    ...metrics.seconds.map(s => `${String(s.second).padStart(6)}  ${printDb(s.peakDbfs).padStart(9)}  ${printDb(s.rmsDbfs).padStart(8)}  ${s.rms.toFixed(6)}`)].join('\n');
}
export function encodeWav(channels: readonly ArrayLike<number>[], sampleRate: number): Buffer {
  const metrics = audioMetrics(channels, sampleRate);
  if (metrics.peak > 1) throw new Error('Refusing to clip WAV samples');
  const frames = channels[0]!.length, count = channels.length, size = frames * count * 2;
  const wav = Buffer.alloc(44 + size);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + size, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(count, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * count * 2, 28);
  wav.writeUInt16LE(count * 2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(size, 40);
  for (let i = 0; i < frames; i++) for (let c = 0; c < count; c++) {
    const v = channels[c]![i]!; wav.writeInt16LE(Math.round(v * (v < 0 ? 32768 : 32767)), 44 + (i * count + c) * 2);
  }
  return wav;
}
