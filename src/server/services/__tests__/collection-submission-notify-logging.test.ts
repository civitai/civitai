import { describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
loggingMock.logToAxiom.mockImplementation(() => Promise.reject(new Error('axiom is unreachable')));

const { mockCreateNotification, mockHomeBlockCacheBust, mockQueueUpdate } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockHomeBlockCacheBust: vi.fn(),
  mockQueueUpdate: vi.fn(),
}));

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
    // No prior membership, so the submission is a real add rather than a no-op re-submission.
    mockDbRead.collectionItem.findMany.mockResolvedValue([]);
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
