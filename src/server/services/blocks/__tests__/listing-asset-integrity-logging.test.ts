import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as LoggingClient from '~/server/logging/client';
import type * as S3Utils from '~/utils/s3-utils';

/**
 * Pins the `.catch()` on the best-effort `logToAxiom(...)` in the listing-media
 * integrity re-check.
 *
 * The call is fire-and-forget: nothing awaits it, because an operational event must
 * never be on the critical path of the attach it is describing. That is exactly what
 * makes a rejecting sink dangerous — `logToAxiom` awaits an ingest that rejects when
 * Axiom is degraded, and an unawaited rejection with no handler goes to
 * `unhandledRejection`, i.e. the observation takes down the request it was only
 * watching. The `.catch()` is the whole defence, and deleting it changes nothing
 * anywhere else in the suite.
 *
 * ## Why this is a separate file
 *
 * 🔴 The sink below is a PLAIN FUNCTION, not a `vi.fn()`, and that is the entire
 * reason this test can fail. A `vi.fn()` records settled results by attaching
 * `returnValue.then(onFulfilled, onRejected)` to whatever the implementation
 * returns, which MARKS a returned rejected promise as handled — so through a
 * `vi.fn()` mock Node never emits `unhandledRejection`, with or without the
 * production `.catch()`, and the assertion passes either way. Unfalsifiable, which
 * is worse than no test. `vi.mock` is per-file and the sibling
 * `listing-asset-upload-integrity.test.ts` deliberately uses `vi.fn()` there so it
 * can assert on payloads; the two shapes cannot coexist in one file. (Same split,
 * same reason, as `~/server/services/__tests__/cover-image.service.logging.test.ts`.)
 */

const { mockRead, mockWrite, mockS3Send } = vi.hoisted(() => {
  const db = {
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      update: vi.fn(async (..._a: unknown[]) => ({})),
    },
    appListingScreenshot: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      count: vi.fn(async (..._a: unknown[]) => 0),
      create: vi.fn(async (..._a: unknown[]) => ({})),
    },
    image: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(db);
      return Promise.all(arg as Promise<unknown>[]);
    }),
  };
  return { mockRead: db, mockWrite: db, mockS3Send: vi.fn() };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/services/image.service', () => ({ createImage: vi.fn() }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => 'apl_test_1',
  newAppListingPublishRequestId: () => 'alpr_test_1',
  newAppListingModerationEventId: () => 'alme_test_1',
  newAppListingScreenshotId: () => 'apls_test_1',
}));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getImageUploadBackend: async () => ({
    s3: { send: mockS3Send },
    bucket: 'test-image-bucket',
    backend: 'backblaze' as const,
  }),
}));

/**
 * A degraded sink. Everything else in the logging module stays REAL, so this test
 * is not also asserting a hand-built module shape.
 */
vi.mock('~/server/logging/client', async (importOriginal) => ({
  ...(await importOriginal<typeof LoggingClient>()),
  logToAxiom: () => Promise.reject(new Error('axiom is unreachable')),
}));

const OWNER = 42;
const KEY = '44444444-4444-4444-8444-444444444444';
/** The tag the row records; the store's answer is varied against it per case. */
const RECORDED_ETAG = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const owner = { id: OWNER, isModerator: false } as never;

const LISTING = {
  id: 'apl_1',
  kind: 'onsite',
  slug: 's',
  name: 'n',
  category: null,
  contentRating: null,
  userId: OWNER,
  iconId: null,
  coverId: null,
};

/** A square icon row that satisfies every column rule, carrying a recorded tag. */
function iconRow() {
  return {
    id: 500,
    userId: OWNER,
    url: KEY,
    type: 'image',
    width: 512,
    height: 512,
    mimeType: 'image/png',
    metadata: { size: 1234, storedEtag: RECORDED_ETAG },
    ingestion: 'Scanned',
    nsfwLevel: 1,
  };
}

async function attachAsIcon() {
  const { setListingIcon } = await import('../app-listing-assets.service');
  return setListingIcon({ listingId: 'apl_1', imageId: 500 }, owner);
}

/**
 * Run `act` and report every rejection Node considered unhandled while it settled.
 *
 * `unhandledRejection` is emitted at the END of the turn in which a promise rejects
 * with no handler attached, so a macrotask wait — not just a microtask flush — is
 * required before reading the result. Vitest's own listener stays installed; Node
 * fans the event out to every listener, so ours still sees it.
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

beforeEach(() => {
  mockS3Send.mockReset();
  mockRead.appListing.findUnique.mockReset().mockResolvedValue(LISTING);
  mockRead.appListing.findFirst.mockReset().mockResolvedValue(null);
  mockRead.appListing.update.mockReset().mockResolvedValue({});
  mockRead.image.findUnique.mockReset().mockResolvedValue(iconRow());
  mockRead.image.findMany.mockReset().mockResolvedValue([]);
  mockWrite.appListingScreenshot.findMany.mockReset().mockResolvedValue([]);
  mockWrite.appListingScreenshot.count.mockReset().mockResolvedValue(0);
  mockWrite.appListingScreenshot.create.mockReset().mockResolvedValue({});
});

describe('listing media — a degraded log sink cannot break the attach it observes', () => {
  /**
   * The fail-OPEN branch. The verdict is `unverifiable`, the attach is supposed to
   * proceed, and the only thing between "proceeds" and "the whole request dies" is
   * the `.catch()` on an event nobody awaits.
   */
  it('still attaches when the sink rejects on an unverifiable verdict', async () => {
    mockS3Send.mockRejectedValue(
      Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 503 } })
    );

    let result: unknown;
    const seen = await unhandledRejectionsDuring(async () => {
      result = await attachAsIcon();
    });

    expect(result).toMatchObject({ status: 'attached' });
    expect(seen).toEqual([]);
  });

  /**
   * The fail-CLOSED branch. The rejection the caller receives must still be the
   * integrity refusal — a sink failure must not replace, mask or precede it.
   */
  it('still refuses with the integrity message when the sink rejects on a mismatch', async () => {
    mockS3Send.mockResolvedValue({ ETag: '"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' });

    let error: unknown;
    const seen = await unhandledRejectionsDuring(async () => {
      error = await attachAsIcon().catch((e) => e);
    });

    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      message: 'that image has changed since it was uploaded — upload it again',
    });
    expect(seen).toEqual([]);
  });

  /**
   * POSITIVE CONTROL. Both cases above are claims about a request that was actually
   * made and a verdict that was actually reached — without this, a build where the
   * re-check never ran would satisfy them for the wrong reason, and `seen` would be
   * empty because nothing ever logged.
   */
  it('reached the store — the cases above are not passing on a skipped check', async () => {
    mockS3Send.mockResolvedValue({ ETag: `"${RECORDED_ETAG}"` });

    await expect(attachAsIcon()).resolves.toMatchObject({ status: 'attached' });

    const heads = mockS3Send.mock.calls.filter(
      ([cmd]) => cmd instanceof HeadObjectCommand && (cmd as HeadObjectCommand).input.Key === KEY
    );
    expect(heads).toHaveLength(1);
  });
});
