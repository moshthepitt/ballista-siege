import { beforeEach, it, expect, vi } from 'vitest';
const { loaded, selected } = vi.hoisted(() => ({ loaded: vi.fn(), selected: vi.fn() }));
vi.mock('./network.js', () => { loaded(); return { selectRun: selected }; });
beforeEach(() => { vi.resetModules(); loaded.mockClear(); selected.mockClear(); });
it('a fresh visit starts a casual local run without importing any chain module', async () => {
  const { selectBackend } = await import('./select-backend.js');
  const result = await selectBackend(13n, 'daily');
  expect(result.backend.state.seed).toBe(13n); expect(result.backend.state.mode).toBe('practice');
  expect(loaded).not.toHaveBeenCalled();
});
it('loads the chain only on request and uses its eligibility choice for a new run', async () => {
  const { selectBackend, loadNetwork } = await import('./select-backend.js');
  await loadNetwork(); expect(loaded).toHaveBeenCalledOnce();
  selected.mockResolvedValue({ backend: 'fixture' });
  expect(await selectBackend(4n,'practice')).toEqual({ backend:'fixture' });
  expect(selected).toHaveBeenCalledWith(4n);
  expect((await selectBackend(4n,'practice','local')).backend.state.seed).toBe(4n);
});
