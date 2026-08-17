// Deliberately outside `src/common`: that directory is a vendored copy that
// `scripts/sync-submodule.ts` re-syncs from event-engine-common, which has no tests. A test
// living there would be deleted by a sync, and the CI ledger derives its expectations from
// disk — so event-engine would drop out of the apps job silently rather than turning red.
import { expect, test } from 'vitest';
import { SignalsService } from '@/common/services/signals';

const originalFetch = globalThis.fetch;

function okResponse(): Response {
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function econnreset(): Error {
  // Mirrors how undici surfaces a keep-alive stale-socket reset: the thrown
  // error carries `cause.code === 'ECONNRESET'`.
  const err = new Error('read ECONNRESET');
  (err as Error & { cause?: unknown }).cause = { code: 'ECONNRESET' };
  return err;
}

function withMockFetch(impl: typeof fetch, run: () => Promise<void>): Promise<void> {
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test('retries once on ECONNRESET and succeeds on the second attempt (never throws)', async () => {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls++;
      if (calls === 1) throw econnreset();
      return okResponse();
    }) as typeof fetch,
    async () => {
      const svc = new SignalsService('http://signals.local', true);
      // Must resolve without throwing; a rejection fails the test with the real error.
      await svc.sendSignal('topic-1', 'metric:update', { a: 1 });
    }
  );
  expect(calls, 'fetch should be attempted twice (initial + one retry)').toBe(2);
});

test('does NOT retry a non-transient error and rethrows it', async () => {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls++;
      throw new Error('boom'); // no cause.code -> not transient
    }) as typeof fetch,
    async () => {
      const svc = new SignalsService('http://signals.local', true);
      await expect(svc.sendSignal('topic-2', 'metric:update', { a: 1 })).rejects.toThrow(/boom/);
    }
  );
  expect(calls, 'non-transient error should not be retried').toBe(1);
});

test('retries at most once, then rethrows on a second consecutive ECONNRESET', async () => {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls++;
      throw econnreset();
    }) as typeof fetch,
    async () => {
      const svc = new SignalsService('http://signals.local', true);
      await expect(svc.sendSignal('topic-3', 'metric:update', { a: 1 })).rejects.toThrow(
        /ECONNRESET/
      );
    }
  );
  expect(calls, 'should attempt exactly twice, then give up').toBe(2);
});

test('is a no-op (never throws) when disabled / no URL configured', async () => {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls++;
      return okResponse();
    }) as typeof fetch,
    async () => {
      const svc = new SignalsService('', true); // disabled: no URL
      await svc.sendSignal('topic-4', 'metric:update', { a: 1 });
    }
  );
  expect(calls, 'disabled service should not call fetch').toBe(0);
});
