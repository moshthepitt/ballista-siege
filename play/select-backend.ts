import type { Mode } from '../src/v1/sim.js';
import { LocalBackend, type GameBackend } from './backend.js';
import { BURNER_KEY, stored } from './browser-storage.js';
let network: typeof import('./network.js') | undefined;
let loading: Promise<typeof import('./network.js')> | undefined;
export const hasSavedBurner = () => !!stored(BURNER_KEY);
export function loadNetwork() {
  return loading ??= import('./network.js').then(module => { network = module; return module; }).catch(error => { loading = undefined; throw error; });
}
export async function selectBackend(seed: bigint, _mode: Mode = 'practice', choice: string | null = null): Promise<{ backend: GameBackend; notice?: string }> {
  if (choice !== 'local' && network) return network.selectRun(seed);
  return { backend: new LocalBackend(seed, 'practice') };
}
