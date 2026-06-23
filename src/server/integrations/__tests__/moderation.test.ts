import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the external-moderation client (moderation.ts).
 *
 * The function runs INLINE on every generation submission (generateFromGraph →
 * auditPromptServer → extModeration.moderatePrompt). It is fail-soft (the caller
 * catches and proceeds with flagged:false). The bug these tests guard: Node's
 * undici `fetch` has no default request timeout, so a slow/hanging moderation
 * gateway (503/504 wave) parked the whole tRPC request off-CPU for ~minutes
 * (observed ~194s api-primary tail). The fix adds `AbortSignal.timeout(...)`.
 */

// Mutable env mock so each test can set the timeout / endpoint. `vi.hoisted` so it
// exists before the hoisted `vi.mock` factory references it.
const env = vi.hoisted(() => ({
  EXTERNAL_MODERATION_ENDPOINT: 'https://moderation.example/v1/moderations' as string,
  EXTERNAL_MODERATION_TOKEN: 'tok' as string,
  EXTERNAL_MODERATION_THRESHOLD: 0.5,
  EXTERNAL_MODERATION_TIMEOUT_MS: 5000,
  EXTERNAL_MODERATION_CATEGORIES: undefined as Record<string, string> | undefined,
}));
vi.mock('~/env/server', () => ({ env }));

import { extModeration } from '~/server/integrations/moderation';

const okResponse = (flagged: boolean) => ({
  ok: true,
  json: async () => ({
    results: [{ flagged, category_scores: {}, categories: {} }],
  }),
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  env.EXTERNAL_MODERATION_ENDPOINT = 'https://moderation.example/v1/moderations';
  env.EXTERNAL_MODERATION_TOKEN = 'tok';
  env.EXTERNAL_MODERATION_TIMEOUT_MS = 5000;
  env.EXTERNAL_MODERATION_CATEGORIES = undefined;
});

describe('extModeration.moderatePrompt', () => {
  it('passes an AbortSignal to fetch (timeout is wired)', async () => {
    const fetchMock = vi.fn(async () => okResponse(false));
    vi.stubGlobal('fetch', fetchMock);
    await extModeration.moderatePrompt('a cat');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts (rejects) when the gateway hangs past the timeout — caller then fails soft', async () => {
    env.EXTERNAL_MODERATION_TIMEOUT_MS = 25;
    // fetch that never resolves on its own — only rejects when the abort fires.
    vi.stubGlobal('fetch', (_url: string, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject((opts.signal as AbortSignal).reason ?? new Error('aborted'))
        );
      });
    });
    const start = Date.now();
    await expect(extModeration.moderatePrompt('a hanging prompt')).rejects.toBeTruthy();
    const elapsed = Date.now() - start;
    // Must reject promptly at the deadline, not park indefinitely.
    expect(elapsed).toBeLessThan(2000);
  });

  it('throws on a non-ok response (503) so the caller fails soft', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable', text: async () => 'upstream connect error' }))
    );
    await expect(extModeration.moderatePrompt('x')).rejects.toThrow(/503/);
  });

  it('short-circuits (no fetch) when endpoint/token are not configured', async () => {
    env.EXTERNAL_MODERATION_ENDPOINT = '' as unknown as string;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await extModeration.moderatePrompt('x');
    expect(r).toEqual({ flagged: false, categories: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns flagged:false for clean content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(false)));
    const r = await extModeration.moderatePrompt('a serene landscape');
    expect(r.flagged).toBe(false);
  });
});
