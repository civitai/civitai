import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { getBlockGatedImagesByIds } from '~/server/services/blocks/block-gated-images.service';
import { resolveAppPublishedImages } from '~/server/services/blocks/block-post.service';

/**
 * The three Image provenance keys the two readers see, driven through their REAL SQL against a
 * Postgres stand-in:
 *   - `blockPublishedAppId` (an app's workflow output) — postable by that app AND readable
 *     cross-user through the gated read;
 *   - `blockUploadedAppId` (an app's `OPEN_IMAGE_UPLOAD { bytes }` upload) — postable by that app
 *     for its OWNER only, and NEVER visible to the gated read, which is cross-user by design;
 *   - `blockSharedUploadAppId` (a viewer-picked upload the app opted in to share) — readable
 *     cross-user through the gated read by THAT app only, once terminally scanned, unflagged and
 *     within the viewer's AND the SFW ceiling (pending hidden to all), and never postable.
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
const PUBLISHED_PENDING_OWN = 113; // viewer's, published by APP, scan not finished
const PRIVATE_UPLOAD_OTHER_USER = 115; // ANOTHER viewer's picked upload, NOT shared: no stamp
// Viewer-picked uploads the app opted in to SHARE (`blockSharedUploadAppId`).
const SHARED_OWN = 201; // viewer's, shared with APP
const SHARED_OTHER_USER = 202; // ANOTHER viewer's, shared with APP
const SHARED_OTHER_APP = 203; // viewer's, shared with OTHER_APP
const SHARED_OTHER_APP_OTHER_USER = 204; // ANOTHER viewer's, shared with OTHER_APP
const SHARED_POSTED = 205; // ANOTHER viewer's, shared with APP, already in a post
const SHARED_PG13 = 206; // ANOTHER viewer's, shared with APP, PG-13
const SHARED_MATURE = 207; // ANOTHER viewer's, shared with APP, R
const SHARED_PENDING_OWN = 208; // viewer's, shared with APP, scan not finished
const SHARED_PENDING_OTHER = 209; // ANOTHER viewer's, shared with APP, scan not finished
const SHARED_FLAGGED = 210; // ANOTHER viewer's, shared with APP, scanned but flagged for review

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
      metadata jsonb,
      "modelRestricted" boolean NOT NULL DEFAULT false
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
          PUBLISHED_PENDING_OWN,
          VIEWER,
          { blockPublishedAppId: APP },
          { nsfwLevel: 0, ingestion: 'Pending' }
        ),
        // Scanned, rated PG, bare: everything a shared upload has except the opt-in stamp.
        row(PRIVATE_UPLOAD_OTHER_USER, OTHER_USER, {}),
        row(SHARED_OWN, VIEWER, { blockSharedUploadAppId: APP }),
        row(SHARED_OTHER_USER, OTHER_USER, { blockSharedUploadAppId: APP }),
        row(SHARED_OTHER_APP, VIEWER, { blockSharedUploadAppId: OTHER_APP }),
        row(SHARED_OTHER_APP_OTHER_USER, OTHER_USER, { blockSharedUploadAppId: OTHER_APP }),
        row(SHARED_POSTED, OTHER_USER, { blockSharedUploadAppId: APP }, { postId: 9 }),
        row(SHARED_PG13, OTHER_USER, { blockSharedUploadAppId: APP }, { nsfwLevel: PG13 }),
        row(SHARED_MATURE, OTHER_USER, { blockSharedUploadAppId: APP }, { nsfwLevel: MATURE }),
        row(
          SHARED_PENDING_OWN,
          VIEWER,
          { blockSharedUploadAppId: APP },
          { nsfwLevel: 0, ingestion: 'Pending' }
        ),
        row(
          SHARED_PENDING_OTHER,
          OTHER_USER,
          { blockSharedUploadAppId: APP },
          { nsfwLevel: 0, ingestion: 'Pending' }
        ),
        row(SHARED_FLAGGED, OTHER_USER, { blockSharedUploadAppId: APP }, { needsReview: 'poi' }),
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

describe('post-from-app `published` source: a SHARED upload is not postable', () => {
  it('🔴 refuses the viewer’s own upload shared with this app (a share is not a post grant)', async () => {
    await expectNotPostable(SHARED_OWN);
  });
});

describe('gated cross-user read: published rows, plus uploads this app was allowed to SHARE', () => {
  it('POSITIVE CONTROL: returns another viewer’s image this app PUBLISHED', async () => {
    const { images } = await gatedRead([PUBLISHED_OTHER_USER]);
    expect(images).toEqual([
      expect.objectContaining({ imageId: PUBLISHED_OTHER_USER, status: 'visible' }),
    ]);
  });

  it('🔴 never returns an image this app UPLOADED from bytes — another viewer’s, or the viewer’s own', async () => {
    // Both are scanned, rated PG and bare: everything a shared upload has, but the bytes key.
    const { images } = await gatedRead([UPLOADED_OTHER_USER, UPLOADED_OWN, PUBLISHED_OTHER_USER]);
    expect(images.map((i) => i.imageId)).toEqual([PUBLISHED_OTHER_USER]);
  });

  it('🔴 returns another viewer’s SHARED, scanned upload, with a moderated url', async () => {
    const { images } = await gatedRead([SHARED_OTHER_USER]);
    expect(images).toEqual([
      {
        imageId: SHARED_OTHER_USER,
        status: 'visible',
        nsfwLevel: BROWSING,
        contentRating: expect.any(String),
        url: `edge:key-${SHARED_OTHER_USER}`,
        width: null,
        height: null,
      },
    ]);
  });

  it('🔴 an upload the app did NOT opt in to share (unstamped) is never returned, even scanned', async () => {
    // The shared upload asked for in the same call is the positive control that the read ran.
    const { images } = await gatedRead([PRIVATE_UPLOAD_OTHER_USER, SHARED_OTHER_USER]);
    expect(images.map((i) => i.imageId)).toEqual([SHARED_OTHER_USER]);
  });

  it('🔴 a shared upload whose scan has not finished is hidden — to everyone, its uploader included', async () => {
    const { images } = await gatedRead([SHARED_PENDING_OWN, SHARED_PENDING_OTHER]);
    expect(images).toEqual([
      { imageId: SHARED_PENDING_OWN, status: 'hidden' },
      { imageId: SHARED_PENDING_OTHER, status: 'hidden' },
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

  it('a flagged shared upload is hidden', async () => {
    const { images } = await gatedRead([SHARED_FLAGGED]);
    expect(images).toEqual([{ imageId: SHARED_FLAGGED, status: 'hidden' }]);
  });

  it('🔴 never returns an upload shared with ANOTHER app, whoever the viewer is', async () => {
    const { images } = await gatedRead([SHARED_OTHER_APP, SHARED_OTHER_APP_OTHER_USER]);
    expect(images).toEqual([]);
    // And the reverse: the other app cannot read THIS app's shared uploads. Its own shared upload,
    // asked for in the same call, is the positive control that the read ran for OTHER_APP at all.
    const other = await gatedReadAs([SHARED_OWN, SHARED_OTHER_USER, SHARED_OTHER_APP], {
      appId: OTHER_APP,
    });
    expect(other.images.map((i) => i.imageId)).toEqual([SHARED_OTHER_APP]);
  });

  it('a shared upload already adopted into a post is not returned (`postId IS NULL`)', async () => {
    const { images } = await gatedRead([SHARED_POSTED]);
    expect(images).toEqual([]);
  });

  it('🔴 the viewer’s level clamps shared uploads: PG-13 is hidden from a PG-only viewer, shown at R', async () => {
    expect((await gatedRead([SHARED_PG13])).images).toEqual([
      { imageId: SHARED_PG13, status: 'hidden' },
    ]);
    expect((await gatedReadAs([SHARED_PG13], { browsingLevel: R_ALLOWED })).images).toEqual([
      expect.objectContaining({ imageId: SHARED_PG13, status: 'visible', nsfwLevel: PG13 }),
    ]);
  });

  it('🔴 shared uploads are SFW-only: an R upload is hidden even from a viewer whose level admits R', async () => {
    const { images } = await gatedReadAs([SHARED_MATURE, PUBLISHED_MATURE], {
      browsingLevel: R_ALLOWED,
    });
    expect(images).toEqual([
      { imageId: SHARED_MATURE, status: 'hidden' },
      // The PUBLISHED row at the same level keeps the viewer clamp alone (unchanged).
      expect.objectContaining({ imageId: PUBLISHED_MATURE, status: 'visible' }),
    ]);
  });
});

describe('gated cross-user read: a mature image made with a restricted base model', () => {
  const RESTRICTED_OTHER_USER = 110;
  const RESTRICTED_OWN = 111;

  beforeEach(async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", url, "nsfwLevel", metadata, "modelRestricted") VALUES
        (${RESTRICTED_OTHER_USER}, ${OTHER_USER}, 'key-${RESTRICTED_OTHER_USER}', ${MATURE},
          '{"blockPublishedAppId":"${APP}"}'::jsonb, true),
        (${RESTRICTED_OWN}, ${VIEWER}, 'key-${RESTRICTED_OWN}', ${MATURE},
          '{"blockPublishedAppId":"${APP}"}'::jsonb, true);
    `);
  });

  const readAtR = (imageIds: number[]) =>
    getBlockGatedImagesByIds({ imageIds, browsingLevel: R_ALLOWED, appId: APP, userId: VIEWER });

  it('is hidden from a viewer who did not upload it, whose ceiling admits its level', async () => {
    const { images } = await readAtR([RESTRICTED_OTHER_USER, PUBLISHED_MATURE]);
    expect(images).toEqual([
      { imageId: RESTRICTED_OTHER_USER, status: 'hidden' },
      expect.objectContaining({ imageId: PUBLISHED_MATURE, status: 'visible' }),
    ]);
  });

  it('is shown to its uploader', async () => {
    const { images } = await readAtR([RESTRICTED_OWN]);
    expect(images).toEqual([
      expect.objectContaining({ imageId: RESTRICTED_OWN, status: 'visible' }),
    ]);
  });
});
