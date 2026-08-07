import { describe, expect, it, vi } from 'vitest';

/**
 * Pins the `.catch()` on the best-effort `logToAxiom(...)` call in the submission-notify
 * failure handler inside `saveItemInCollections` (collection.service.ts).
 *
 * ## Why this is a separate file
 *
 * 🔴 The mock below is a PLAIN FUNCTION, not a `vi.fn()`, and that is the entire reason this
 * test can fail. A `vi.fn()` records settled results by attaching
 * `returnValue.then(onFulfilled, onRejected)` to whatever the implementation returns — which
 * MARKS a returned rejected promise as handled. Through a `vi.fn()` mock, Node therefore never
 * emits `unhandledRejection` whether or not the production `.catch()` has an actual handler, so
 * any assertion written against a `vi.fn()` mock passes either way: unfalsifiable, which is worse
 * than no test. (See `src/server/services/__tests__/cover-image.service.logging.test.ts`, the
 * precedent this file mirrors.)
 *
 * `collection-submission-notify-failure-isolation.test.ts` deliberately mocks
 * `~/server/logging/client` with a `vi.fn()` so it can assert on the log payload. The two mock
 * shapes cannot coexist in one file, hence this second file.
 */
vi.mock('~/server/logging/client', () => ({
  logToAxiom: () => Promise.reject(new Error('axiom is unreachable')),
}));

const { mockDbRead, mockDbWrite, mockCreateNotification, mockHomeBlockCacheBust, mockQueueUpdate } =
  vi.hoisted(() => ({
    mockDbRead: {
      collection: { findMany: vi.fn() },
      $queryRaw: vi.fn(),
      collectionContributor: { findMany: vi.fn() },
    },
    mockDbWrite: {
      $executeRaw: vi.fn(),
      $transaction: vi.fn(),
    },
    mockCreateNotification: vi.fn(),
    mockHomeBlockCacheBust: vi.fn(),
    mockQueueUpdate: vi.fn(),
  }));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));
vi.mock('~/server/services/home-block-cache.service', () => ({
  homeBlockCacheBust: mockHomeBlockCacheBust,
}));
vi.mock('~/server/search-index', () => ({
  collectionsSearchIndex: { queueUpdate: mockQueueUpdate },
  imagesSearchIndex: { queueUpdate: vi.fn() },
}));

const { saveItemInCollections } = await import('~/server/services/collection.service');

const COLLECTION_ID = 10;
const OWNER_ID = 999;
const SUBMITTER_ID = 555;
const IMAGE_ID = 42;

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

describe('saveItemInCollections — submission-notify failure logging cannot itself crash the process', () => {
  it('swallows a logToAxiom failure when resolving recipients also fails', async () => {
    mockDbRead.collection.findMany.mockResolvedValue([
      {
        id: COLLECTION_ID,
        name: 'Test Collection',
        description: null,
        read: 'Public',
        write: 'Review',
        type: null,
        nsfw: false,
        nsfwLevel: 0,
        image: null,
        mode: null,
        metadata: {},
        availability: 'Public',
        userId: OWNER_ID,
        tags: [],
      },
    ]);
    mockDbRead.$queryRaw.mockResolvedValue([
      {
        id: COLLECTION_ID,
        read: 'Public',
        write: 'Review',
        userId: OWNER_ID,
        type: null,
        mode: null,
        contributorPermissions: ['ADD_REVIEW'],
        collaborationDisabledAt: null,
      },
    ]);
    mockDbWrite.$transaction.mockResolvedValue(undefined);
    // The compound failure this test pins: the recipient query ALSO fails, so the
    // try/catch's own logToAxiom call is what's under test here, not the happy path.
    mockDbRead.collectionContributor.findMany.mockRejectedValue(new Error('replica hiccup'));

    let result: unknown;
    const seen = await unhandledRejectionsDuring(async () => {
      result = await saveItemInCollections({
        input: {
          collections: [{ collectionId: COLLECTION_ID }],
          imageId: IMAGE_ID,
          userId: SUBMITTER_ID,
          isModerator: false,
        } as never,
      });
    });

    // The logging failure must not change the outcome the caller acts on: the item write
    // already committed, so the submit must still report success.
    expect(result).toBe('added');
    expect(seen).toEqual([]);
  });
});
