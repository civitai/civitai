import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { getBlockGatedImagesByIds } from '~/server/services/blocks/block-gated-images.service';
import { resolveAppPublishedImages } from '~/server/services/blocks/block-post.service';

/**
 * The two Image provenance keys, driven through the REAL SQL of both readers against a Postgres
 * stand-in:
 *   - `blockPublishedAppId` (an app's workflow output) — postable by that app AND readable
 *     cross-user through the gated read;
 *   - `blockUploadedAppId` (an image uploaded through an app) — postable by that app for its OWNER
 *     only, and readable cross-user through the gated read by THAT app only, once terminally
 *     scanned, unflagged and within the viewer's AND the SFW ceiling; pending is hidden to all.
 *
 * Each fixture row differs from an accepted one in exactly one field, so each refusal is a claim
 * about one conjunct.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/services/blocks/block-workflows.service', () => ({
  blockWorkflowOwnedByAppUser: vi.fn(),
}));
vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (url: string) => `edge:${url}`,
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: async () => ({
    hiddenUsers: [],
    blockedUsers: [],
    blockedByUsers: [],
    hiddenTags: [],
  }),
}));

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const APP = 'appblk-alpha';
const OTHER_APP = 'appblk-beta';
const VIEWER = 42;
const OTHER_USER = 7;
/** PG — inside the viewer's ceiling. */
const BROWSING = 1;
/** R — outside a PG-only ceiling. */
const MATURE = 4;
/** PG-13 — inside the SFW ceiling, but NOT inside the PG-only `BROWSING` ceiling. */
const PG13 = 2;
/** PG | PG-13 | R — a viewer whose own ceiling admits R. */
const R_ALLOWED = 1 | 2 | 4;

const PUBLISHED_OWN = 101; // viewer's, published by APP
const UPLOADED_OWN = 102; // viewer's, uploaded by APP
const UPLOADED_OTHER_USER = 103; // ANOTHER viewer's, uploaded by APP
const UPLOADED_OTHER_APP = 104; // viewer's, uploaded by OTHER_APP
const UPLOADED_POSTED = 105; // viewer's, uploaded by APP, already in a post
const UPLOADED_MATURE = 106; // viewer's, uploaded by APP, above the ceiling
const PUBLISHED_OTHER_USER = 107; // ANOTHER viewer's, published by APP
const PUBLISHED_MATURE = 108; // viewer's, published by APP, R
const UPLOADED_PG13 = 109; // viewer's, uploaded by APP, PG-13
const UPLOADED_PENDING_OWN = 110; // viewer's, uploaded by APP, scan not finished
const UPLOADED_PENDING_OTHER = 111; // ANOTHER viewer's, uploaded by APP, scan not finished
const UPLOADED_FLAGGED = 112; // ANOTHER viewer's, uploaded by APP, scanned but flagged for review
const PUBLISHED_PENDING_OWN = 113; // viewer's, published by APP, scan not finished
const UPLOADED_OTHER_APP_OTHER_USER = 114; // ANOTHER viewer's, uploaded by OTHER_APP

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      url text NOT NULL,
      "postId" int,
      "nsfwLevel" int NOT NULL,
      ingestion text NOT NULL DEFAULT 'Scanned',
      width int,
      height int,
      "needsReview" text,
      poi boolean,
      minor boolean,
      "tosViolation" boolean,
      "acceptableMinor" boolean,
      "blockedFor" text,
      metadata jsonb
    );
    CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean);
  `);
});

beforeEach(async () => {
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return (await holder.db.query(flat.text, flat.values as unknown[])).rows;
  }) as never);

  const row = (
    id: number,
    userId: number,
    metadata: Record<string, string>,
    over: { postId?: number; nsfwLevel?: number; ingestion?: string; needsReview?: string } = {}
  ) =>
    `(${id}, ${userId}, 'key-${id}', ${over.postId ?? 'NULL'}, ${over.nsfwLevel ?? BROWSING},
      '${over.ingestion ?? 'Scanned'}', ${over.needsReview ? `'${over.needsReview}'` : 'NULL'},
      '${JSON.stringify(metadata)}'::jsonb)`;
  await holder.db.exec(`
    TRUNCATE "Image";
    INSERT INTO "Image" (id, "userId", url, "postId", "nsfwLevel", ingestion, "needsReview", metadata) VALUES
      ${[
        row(PUBLISHED_OWN, VIEWER, { blockPublishedAppId: APP }),
        row(UPLOADED_OWN, VIEWER, { blockUploadedAppId: APP }),
        row(UPLOADED_OTHER_USER, OTHER_USER, { blockUploadedAppId: APP }),
        row(UPLOADED_OTHER_APP, VIEWER, { blockUploadedAppId: OTHER_APP }),
        row(UPLOADED_POSTED, VIEWER, { blockUploadedAppId: APP }, { postId: 9 }),
        row(UPLOADED_MATURE, VIEWER, { blockUploadedAppId: APP }, { nsfwLevel: MATURE }),
        row(PUBLISHED_OTHER_USER, OTHER_USER, { blockPublishedAppId: APP }),
        row(PUBLISHED_MATURE, VIEWER, { blockPublishedAppId: APP }, { nsfwLevel: MATURE }),
        row(UPLOADED_PG13, VIEWER, { blockUploadedAppId: APP }, { nsfwLevel: PG13 }),
        row(
          UPLOADED_PENDING_OWN,
          VIEWER,
          { blockUploadedAppId: APP },
          { nsfwLevel: 0, ingestion: 'Pending' }
        ),
        row(
          UPLOADED_PENDING_OTHER,
          OTHER_USER,
          { blockUploadedAppId: APP },
          { nsfwLevel: 0, ingestion: 'Pending' }
        ),
        row(UPLOADED_FLAGGED, OTHER_USER, { blockUploadedAppId: APP }, { needsReview: 'poi' }),
        row(
          PUBLISHED_PENDING_OWN,
          VIEWER,
          { blockPublishedAppId: APP },
          { nsfwLevel: 0, ingestion: 'Pending' }
        ),
        row(UPLOADED_OTHER_APP_OTHER_USER, OTHER_USER, { blockUploadedAppId: OTHER_APP }),
      ].join(',\n')};
  `);
});

const postable = (imageIds: number[]) =>
  resolveAppPublishedImages({ imageIds, userId: VIEWER, appId: APP, browsingLevel: BROWSING });

const postableAtR = (imageIds: number[]) =>
  resolveAppPublishedImages({ imageIds, userId: VIEWER, appId: APP, browsingLevel: R_ALLOWED });

const gatedRead = (imageIds: number[]) =>
  getBlockGatedImagesByIds({ imageIds, browsingLevel: BROWSING, appId: APP, userId: VIEWER });

const gatedReadAs = (
  imageIds: number[],
  over: { browsingLevel?: number; appId?: string; userId?: number } = {}
) =>
  getBlockGatedImagesByIds({
    imageIds,
    browsingLevel: over.browsingLevel ?? BROWSING,
    appId: over.appId ?? APP,
    userId: over.userId ?? VIEWER,
  });

async function expectNotPostable(id: number) {
  const p = postable([id]);
  await expect(p).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'an image is not available to post',
  });
  await p.catch((e) => expect(e).toBeInstanceOf(TRPCError));
}

describe('post-from-app `published` source: accepts either provenance key, all other guards unchanged', () => {
  it('accepts the viewer’s own image this app UPLOADED', async () => {
    const out = await postable([UPLOADED_OWN]);
    expect(out.map((i) => i.imageId)).toEqual([UPLOADED_OWN]);
  });

  it('still accepts the viewer’s own image this app PUBLISHED (the pre-existing key)', async () => {
    const out = await postable([PUBLISHED_OWN]);
    expect(out.map((i) => i.imageId)).toEqual([PUBLISHED_OWN]);
  });

  it.each([
    ['ANOTHER viewer’s upload — the owner conjunct binds the new key too', UPLOADED_OTHER_USER],
    ['an upload by a DIFFERENT app', UPLOADED_OTHER_APP],
    ['an upload already adopted into a post (`postId IS NULL`)', UPLOADED_POSTED],
    ['an upload above the viewer’s maturity ceiling', UPLOADED_MATURE],
  ])('refuses %s', async (_label, id) => {
    await expectNotPostable(id);
  });
});

describe('uploaded rows are SFW-only on the post path; published rows keep the viewer clamp', () => {
  it('🔴 refuses an R-level UPLOADED row even for a viewer whose ceiling admits R', async () => {
    const p = postableAtR([UPLOADED_MATURE]);
    await expect(p).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'an image is not available to post',
    });
  });

  it('still accepts SFW uploaded rows (PG and PG-13) for that viewer', async () => {
    const out = await postableAtR([UPLOADED_OWN, UPLOADED_PG13]);
    expect(out.map((i) => [i.imageId, i.nsfwLevel])).toEqual([
      [UPLOADED_OWN, BROWSING],
      [UPLOADED_PG13, PG13],
    ]);
  });

  it('still accepts an R-level PUBLISHED row for a viewer whose ceiling admits R (unchanged)', async () => {
    const out = await postableAtR([PUBLISHED_MATURE]);
    expect(out.map((i) => [i.imageId, i.nsfwLevel])).toEqual([[PUBLISHED_MATURE, MATURE]]);
  });

  it('the viewer clamp still applies to that PUBLISHED row for a PG-only viewer', async () => {
    await expectNotPostable(PUBLISHED_MATURE);
  });
});

describe('gated cross-user read: published rows, plus this app’s own SCANNED uploads', () => {
  it('POSITIVE CONTROL: returns another viewer’s image this app PUBLISHED', async () => {
    const { images } = await gatedRead([PUBLISHED_OTHER_USER]);
    expect(images).toEqual([
      expect.objectContaining({ imageId: PUBLISHED_OTHER_USER, status: 'visible' }),
    ]);
  });

  it('🔴 returns another viewer’s scanned upload THROUGH THIS APP, with a moderated url', async () => {
    const { images } = await gatedRead([UPLOADED_OTHER_USER]);
    expect(images).toEqual([
      {
        imageId: UPLOADED_OTHER_USER,
        status: 'visible',
        nsfwLevel: BROWSING,
        contentRating: expect.any(String),
        url: `edge:key-${UPLOADED_OTHER_USER}`,
        width: null,
        height: null,
      },
    ]);
  });

  it('🔴 an upload whose scan has not finished is hidden — to everyone, its uploader included', async () => {
    const { images } = await gatedRead([UPLOADED_PENDING_OWN, UPLOADED_PENDING_OTHER]);
    expect(images).toEqual([
      { imageId: UPLOADED_PENDING_OWN, status: 'hidden' },
      { imageId: UPLOADED_PENDING_OTHER, status: 'hidden' },
    ]);
  });

  it('CONTROL: a PUBLISHED pending image still reaches its own author as ratingPending (unchanged)', async () => {
    const { images } = await gatedRead([PUBLISHED_PENDING_OWN]);
    expect(images).toEqual([
      expect.objectContaining({
        imageId: PUBLISHED_PENDING_OWN,
        status: 'visible',
        ratingPending: true,
      }),
    ]);
  });

  it('a flagged upload is hidden', async () => {
    const { images } = await gatedRead([UPLOADED_FLAGGED]);
    expect(images).toEqual([{ imageId: UPLOADED_FLAGGED, status: 'hidden' }]);
  });

  it('🔴 never returns an upload made through ANOTHER app, whoever the viewer is', async () => {
    const { images } = await gatedRead([UPLOADED_OTHER_APP, UPLOADED_OTHER_APP_OTHER_USER]);
    expect(images).toEqual([]);
    // And the reverse: the other app cannot read THIS app's uploads.
    const other = await gatedReadAs([UPLOADED_OWN, UPLOADED_OTHER_USER], { appId: OTHER_APP });
    expect(other.images.map((i) => i.imageId)).toEqual([UPLOADED_OTHER_APP]);
  });

  it('an upload already adopted into a post is not returned (`postId IS NULL`)', async () => {
    const { images } = await gatedRead([UPLOADED_POSTED]);
    expect(images).toEqual([]);
  });

  it('🔴 the viewer’s level clamps uploads: PG-13 is hidden from a PG-only viewer, shown at R', async () => {
    expect((await gatedRead([UPLOADED_PG13])).images).toEqual([
      { imageId: UPLOADED_PG13, status: 'hidden' },
    ]);
    expect((await gatedReadAs([UPLOADED_PG13], { browsingLevel: R_ALLOWED })).images).toEqual([
      expect.objectContaining({ imageId: UPLOADED_PG13, status: 'visible', nsfwLevel: PG13 }),
    ]);
  });

  it('🔴 uploads are SFW-only: an R upload is hidden even from a viewer whose level admits R', async () => {
    const { images } = await gatedReadAs([UPLOADED_MATURE, PUBLISHED_MATURE], {
      browsingLevel: R_ALLOWED,
    });
    expect(images).toEqual([
      { imageId: UPLOADED_MATURE, status: 'hidden' },
      // The PUBLISHED row at the same level keeps the viewer clamp alone (unchanged).
      expect.objectContaining({ imageId: PUBLISHED_MATURE, status: 'visible' }),
    ]);
  });
});
