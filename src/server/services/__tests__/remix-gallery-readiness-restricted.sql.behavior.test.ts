import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as PlacementEscrow from '~/server/services/placement-escrow.service';
import {
  REMIX_GALLERY_SURFACE,
  REMIX_GALLERY_TARGET_TYPE,
} from '~/server/services/remix-gallery-hosts.cache';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The readiness pass's selection, run as written against an in-process Postgres: a submission whose
 * mature image was made with a base model that restricts mature images is refunded while it still
 * waits for its scan, as a ToS-flagged one is.
 */

const settlePlacement = vi.fn(async (_args: { placementId: number; action: string }) => ({
  settled: true,
}));
vi.mock('~/server/services/placement-escrow.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementEscrow>()),
  settlePlacement,
}));
vi.mock('~/server/services/placement.service', () => ({
  getPlacementConfig: async () => ({ expiryHours: () => 48 }),
}));

const { startReadyRemixSubmissionClocks } = await import('~/server/services/remix-gallery.service');

const R = 4;
const PG = 1;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3));
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int, "userId" int NOT NULL,
      "nsfwLevel" int NOT NULL, "modelRestricted" boolean,
      "tosViolation" boolean NOT NULL DEFAULT false, minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false, ingestion text NOT NULL DEFAULT 'Pending',
      "needsReview" text);
    CREATE TABLE "Placement" (id int PRIMARY KEY, surface text, "targetType" text,
      "targetId" int, status text, data jsonb);
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockImplementation(pgliteRaw(pg).queryRaw as never);
  await pg.exec(`TRUNCATE "Post", "Image", "Placement"`);
});

/** One submission awaiting readiness, its image still scanning. */
async function awaitingSubmission(
  placementId: number,
  image: { nsfwLevel: number; modelRestricted: boolean | null }
) {
  const imageId = placementId * 10;
  await pg.query(
    `INSERT INTO "Image" (id, "userId", "nsfwLevel", "modelRestricted") VALUES ($1, 2, $2, $3)`,
    [imageId, image.nsfwLevel, image.modelRestricted]
  );
  await pg.query(
    `INSERT INTO "Placement" (id, surface, "targetType", "targetId", status, data)
     VALUES ($1, $2, $3, 500, 'pending', $4)`,
    [
      placementId,
      REMIX_GALLERY_SURFACE,
      REMIX_GALLERY_TARGET_TYPE,
      JSON.stringify({ imageId, awaitingReadiness: true }),
    ]
  );
}

const refundedIds = () => settlePlacement.mock.calls.map(([args]) => args.placementId).sort();

describe('startReadyRemixSubmissionClocks and restricted images', () => {
  it('refunds a still-scanning submission whose mature image is restricted', async () => {
    await awaitingSubmission(1, { nsfwLevel: R, modelRestricted: true });
    // A missing flag on a mature image counts as restricted.
    await awaitingSubmission(2, { nsfwLevel: R, modelRestricted: null });
    // Controls: neither is restricted, so both wait for their scan.
    await awaitingSubmission(3, { nsfwLevel: R, modelRestricted: false });
    await awaitingSubmission(4, { nsfwLevel: PG, modelRestricted: true });

    await expect(startReadyRemixSubmissionClocks({})).resolves.toMatchObject({
      considered: 2,
      refunded: 2,
    });
    expect(refundedIds()).toEqual([1, 2]);
    expect(settlePlacement).toHaveBeenCalledWith({ placementId: 1, action: 'expire' });
  });
});
