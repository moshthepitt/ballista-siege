import { vi } from 'vitest';

export class MockParam {
  value = 1;
  events: { method: string; value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number) { this.value = value; this.events.push({ method: 'set', value, time }); return this; }
  linearRampToValueAtTime(value: number, time: number) { this.value = value; this.events.push({ method: 'linear', value, time }); return this; }
  exponentialRampToValueAtTime(value: number, time: number) { this.value = value; this.events.push({ method: 'exponential', value, time }); return this; }
  setTargetAtTime(value: number, time: number) { this.value = value; this.events.push({ method: 'target', value, time }); return this; }
  cancelScheduledValues = vi.fn();
  cancelAndHoldAtTime = vi.fn();
}
export class MockNode {
  connections: MockNode[] = [];
  gain = new MockParam(); pan = new MockParam(); frequency = new MockParam(); Q = new MockParam();
  threshold = new MockParam(); knee = new MockParam(); ratio = new MockParam(); attack = new MockParam(); release = new MockParam();
  type = ''; buffer: unknown = null; loop = false;
  curve: Float32Array | null = null; oversample = 'none';
  start = vi.fn(); stop = vi.fn();
  onended: (() => void) | null = null;
  constructor(readonly kind: string) {}
  connect(node: MockNode) { this.connections.push(node); return node; }
  disconnect = vi.fn(() => { this.connections = []; });
}
export class MockContext {
  currentTime = 0;
  state: AudioContextState = 'suspended';
  sampleRate = 48000;
  destination = new MockNode('destination');
  nodes: MockNode[] = [];
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  private add(kind: string) { const node = new MockNode(kind); this.nodes.push(node); return node; }
  createGain = () => this.add('gain');
  createStereoPanner = () => this.add('panner');
  createDynamicsCompressor = () => this.add('compressor');
  createWaveShaper = () => this.add('limiter');
  createOscillator = () => this.add('oscillator');
  createBufferSource = () => this.add('noise');
  createBiquadFilter = () => this.add('filter');
  createBuffer = (_channels: number, length: number, _rate: number) => ({ getChannelData: () => new Float32Array(length) });
  asAudioContext(): AudioContext { return this as unknown as AudioContext; }
}
export function reaches(node: MockNode, target: MockNode, seen = new Set<MockNode>()): boolean {
  if (node === target) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return node.connections.some(next => reaches(next, target, seen));
}
export function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
}
