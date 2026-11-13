import { beforeEach, describe, expect, it, vi } from 'vitest';

const callMainApp = vi.fn();
vi.mock('$lib/server/main-app', () => ({ callMainApp }));

const { bustVersionCache } = await import('../monetization/bust-cache');

const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);
const sentIds = () =>
  callMainApp.mock.calls.map(([, , init]) => (init as { body: { versionIds: number[] } }).body.versionIds);

beforeEach(() => {
  callMainApp.mockReset();
  callMainApp.mockResolvedValue({ ok: true });
});

describe('bustVersionCache', () => {
  it('splits more ids than the endpoint accepts into requests it will accept', async () => {
    await bustVersionCache('cookie', ids(1, 600));

    expect(sentIds()).toEqual([ids(1, 500), ids(501, 100)]);
    for (const [endpoint, cookie, init] of callMainApp.mock.calls)
      expect([endpoint, cookie, init]).toEqual([
        '/api/v1/model-versions/bust-cache',
        'cookie',
        { method: 'POST', body: expect.any(Object), parse: false, timeoutMs: 3000 },
      ]);
  });

  it('sends the chunks at once, so the wait stays one timeout', async () => {
    let release!: () => void;
    const held = new Promise<{ ok: true }>((resolve) => (release = () => resolve({ ok: true })));
    callMainApp.mockReturnValue(held);

    const pending = bustVersionCache('cookie', ids(1, 1001));
    await Promise.resolve();

    // Every request is in flight before any of them answers.
    expect(sentIds().map((chunk) => chunk.length)).toEqual([500, 500, 1]);
    release();
    await pending;
  });

  it('sends nothing for no ids', async () => {
    await bustVersionCache('cookie', []);
    expect(callMainApp).not.toHaveBeenCalled();
  });
});
