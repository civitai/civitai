import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CloudflareClient from '~/server/cloudflare/client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const purge = vi.hoisted(() => ({ next: (): Promise<void> => Promise.resolve() }));
vi.mock('~/server/cloudflare/client', async (importOriginal) => ({
  ...(await importOriginal<typeof CloudflareClient>()),
  purgeCache: vi.fn(() => purge.next()),
}));

const { purgeCache } = await import('~/server/cloudflare/client');
const { purgeOnSuccess } = await import('~/server/middleware.trpc');
const { createCallerFactory, publicProcedure, router } = await import('~/server/trpc');
const { TokenScope } = await import('~/shared/constants/token-scope.constants');

const TAG = 'purge-on-success-test';
const testRouter = router({
  save: publicProcedure.use(purgeOnSuccess([TAG])).mutation(() => ({ saved: true })),
});
const call = createCallerFactory(testRouter);
const ctx = () =>
  ({
    user: undefined,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { canViewNsfw: false },
    cache: { edgeTTL: 0, browserTTL: 0, canCache: true, skip: false },
    req: { url: '/api/trpc/save', query: {}, headers: {} },
    res: undefined,
  } as never);

beforeEach(() => {
  purge.next = () => Promise.resolve();
  vi.mocked(purgeCache).mockClear();
  loggingMock.logToAxiom.mockClear();
});

describe('purgeOnSuccess', () => {
  it('returns a save without waiting for the purge it starts', async () => {
    purge.next = () => new Promise<void>(() => undefined);
    const c = ctx();
    const settled = call(c)
      .save()
      .then(() => 'returned');
    const state = await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(() => resolve('still waiting on the purge'), 50)),
    ]);
    expect(state).toBe('returned');
    expect(purgeCache).toHaveBeenCalledWith({ tags: [TAG] });
  });

  it('logs a failed purge with its tags and procedure, and still returns the save', async () => {
    purge.next = () => Promise.reject(new Error('purge failed'));
    const c = ctx();
    await expect(call(c).save()).resolves.toEqual({ saved: true });
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'edge-purge-failed', tags: [TAG], path: 'save' }),
        expect.anything()
      )
    );
  });
});
