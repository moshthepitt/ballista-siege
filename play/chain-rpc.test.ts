import { describe, expect, it } from 'vitest';
import { call, isRateLimited } from './chain-rpc.js';

const limited = { context: { statusCode: 429 }, message: 'Too Many Requests' };
const request = (outcomes: unknown[]) => {
  let sent = 0;
  return { get sent() { return sent; }, send: async () => { const next = outcomes[sent++]; if (next instanceof Error || (typeof next === 'object' && next && 'context' in next)) throw next; return next; } };
};

describe('rate-limited RPC calls', () => {
  it('recognizes HTTP 429 directly or as a cause', () => {
    expect(isRateLimited(limited)).toBe(true);
    expect(isRateLimited(new Error('wrapped', { cause: limited }))).toBe(true);
    expect(isRateLimited({ context: { statusCode: 500 } })).toBe(false);
    expect(isRateLimited(new Error('plain'))).toBe(false);
  });
  it('sends again after a 429 and returns the first answer', async () => {
    const r = request([limited, limited, 'ok']);
    await expect(call(r, [0, 0, 0])).resolves.toBe('ok');
    expect(r.sent).toBe(3);
  });
  it('rethrows other errors at once', async () => {
    const r = request([new Error('boom'), 'ok']);
    await expect(call(r, [0, 0])).rejects.toThrow('boom');
    expect(r.sent).toBe(1);
  });
  it('gives up after the last wait', async () => {
    const r = request([limited, limited, limited]);
    await expect(call(r, [0, 0])).rejects.toBe(limited);
    expect(r.sent).toBe(3);
  });
});
