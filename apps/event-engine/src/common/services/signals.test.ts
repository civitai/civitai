import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalsService } from './signals';

/**
 * These tests use Node's built-in test runner (`node:test`) so they need no
 * extra dev dependency / jest-transform wiring. Run with the repo's `tsx`:
 *   pnpm --filter @civitai/event-engine exec tsx --test src/common/services/signals.test.ts
 */

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
      // Must resolve without throwing.
      await assert.doesNotReject(svc.sendSignal('topic-1', 'metric:update', { a: 1 }));
    }
  );
  assert.equal(calls, 2, 'fetch should be attempted twice (initial + one retry)');
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
      await assert.rejects(svc.sendSignal('topic-2', 'metric:update', { a: 1 }), /boom/);
    }
  );
  assert.equal(calls, 1, 'non-transient error should not be retried');
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
      await assert.rejects(svc.sendSignal('topic-3', 'metric:update', { a: 1 }), /ECONNRESET/);
    }
  );
  assert.equal(calls, 2, 'should attempt exactly twice, then give up');
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
      await assert.doesNotReject(svc.sendSignal('topic-4', 'metric:update', { a: 1 }));
    }
  );
  assert.equal(calls, 0, 'disabled service should not call fetch');
});
