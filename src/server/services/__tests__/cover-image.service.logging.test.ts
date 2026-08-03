import { describe, expect, it, vi } from 'vitest';

/**
 * Pins the `.catch()` on the best-effort `logToAxiom(...)` calls in `cover-image.service`.
 *
 * ## Why this is a separate file
 *
 * 🔴 The mock below is a PLAIN FUNCTION, not a `vi.fn()`, and that is the entire reason this
 * test can fail. A `vi.fn()` records settled results by attaching
 * `returnValue.then(onFulfilled, onRejected)` to whatever the implementation returns — which
 * MARKS a returned rejected promise as handled. Through a `vi.fn()` mock, Node therefore never
 * emits `unhandledRejection` whether or not the production `.catch()` exists, so any assertion
 * written against a `vi.fn()` mock passes either way: unfalsifiable, which is worse than no test.
 *
 * `vi.mock` is per-file, and the main suite (`cover-image.service.test.ts`) deliberately mocks
 * `~/server/logging/client` with `vi.fn()`s so it can assert on the payloads. The two mock shapes
 * cannot coexist in one file, hence this second file.
 */
vi.mock('~/server/logging/client', () => ({
  logToAxiom: () => Promise.reject(new Error('axiom is unreachable')),
  safeError: (e: unknown) => ({ message: (e as Error)?.message }),
}));

// The module under test imports these only to build its production deps; stub the graphs out.
const { getImageUploadBackendMock } = vi.hoisted(() => ({
  getImageUploadBackendMock: vi.fn(),
}));

vi.mock('~/server/db/client', () => {
  const dbMock = { image: { findMany: vi.fn() } };
  return { dbWrite: dbMock, dbRead: dbMock };
});
vi.mock('~/server/services/image.service', () => ({ createImage: vi.fn() }));
vi.mock('~/utils/s3-utils', () => ({
  checkFileExists: vi.fn(),
  getImageUploadBackend: getImageUploadBackendMock,
}));

import { productionCoverImageDeps } from '../cover-image.service';

const url = '0d5f0a4e-0000-4000-8000-000000000001';

/**
 * Run `act` and report every rejection Node considered unhandled while it settled.
 *
 * `unhandledRejection` is emitted at the END of the turn in which a promise rejects with no
 * handler attached, so a macrotask wait (not just a microtask flush) is required before reading
 * the result. Vitest's own listener stays installed — Node fans the event out to every listener,
 * so ours still sees it, and a genuinely unhandled rejection additionally surfaces as a run-level
 * error, which is the outcome this test exists to prevent.
 */
async function unhandledRejectionsDuring(act: () => void | Promise<unknown>) {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await act();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

describe('cover-image.service — best-effort logging cannot break the save it observes', () => {
  it('swallows a logToAxiom failure on the proceeded-unverified branch', async () => {
    const seen = await unhandledRejectionsDuring(() => {
      // Fire-and-forget by design: the caller does not await this, so a rejecting
      // `logToAxiom` has nowhere to go except `unhandledRejection` — unless it is caught here.
      productionCoverImageDeps.logExistenceUnknown({ userId: 7 });
    });

    expect(seen).toEqual([]);
  });

  it('swallows a logToAxiom failure on the client-unavailable branch, and still reports unknown', async () => {
    getImageUploadBackendMock.mockRejectedValue(
      new Error('B2 image upload credentials not configured')
    );

    let result: boolean | null | undefined;
    const seen = await unhandledRejectionsDuring(async () => {
      result = await productionCoverImageDeps.objectExists(url);
    });

    // The logging failure must not change the answer the caller acts on: still "unknown",
    // so the save fails open rather than rejecting a user's cover.
    expect(result).toBeNull();
    expect(seen).toEqual([]);
  });
});
