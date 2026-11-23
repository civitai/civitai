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
 *     within the viewer's AND the SFW ceiling (pending hidden to all), and never postable;
 *   - `blockGenerationSourceAppId` (a PRIVATE generation source) — readable through the gated read
 *     by its OWN author and the app that kept it only, with the published content filter and
 *     `ratingPending` while unrated; omitted for anyone else, and omitted for its author too when
 *     restricted, blocked or held. Never postable.
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
const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  /** The rows the last query returned: what left Postgres. */
  lastRows: [] as Array<{ id: number }>,
  /** Tag ids the viewer hides (default none). */
  hiddenTagIds: [] as number[],
}));

vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: async () => ({
    hiddenUsers: [],
    blockedUsers: [],
    blockedByUsers: [],
    hiddenTags: holder.hiddenTagIds.map((id) => ({ id, hidden: true })),
  }),
}));

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
// PRIVATE generation sources (`blockGenerationSourceAppId`).
const GS_OWN = 301; // viewer's, kept by APP, scanned PG
const GS_OTHER_USER = 302; // ANOTHER viewer's, kept by APP, scanned PG
const GS_OTHER_APP = 303; // viewer's, kept by OTHER_APP, scanned PG
const GS_PENDING_OWN = 304; // viewer's, kept by APP, scan not finished
const GS_PENDING_OTHER_USER = 305; // ANOTHER viewer's, kept by APP, scan not finished
const GS_FLAGGED_OWN = 306; // viewer's, kept by APP, scanned but held for review
const GS_SCAN_BLOCKED_OWN = 307; // viewer's, kept by APP, the scanner refused the bytes
const GS_MATURE_OWN = 308; // viewer's, kept by APP, R
const GS_POSTED_OWN = 309; // viewer's, kept by APP, already in a post
const GS_RESTRICTED_OWN = 310; // viewer's, kept by APP, R + restricted base model
const GS_HARD_BLOCKED_OWN = 311; // viewer's, kept by APP, hard-blocked by moderation
const GS_HIDDEN_TAG_OWN = 312; // viewer's, kept by APP, carries a tag the viewer hides
const PUBLISHED_AND_GS_OTHER_USER = 313; // ANOTHER viewer's, published AND kept as a source by APP
const HIDDEN_TAG = 99;

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
    const rows = (await holder.db.query(flat.text, flat.values as unknown[])).rows;
    holder.lastRows = rows as Array<{ id: number }>;
    return rows;
  }) as never);
  holder.lastRows = [];
  holder.hiddenTagIds = [];

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
    TRUNCATE "TagsOnImageDetails";
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
        row(GS_OWN, VIEWER, { blockGenerationSourceAppId: APP }),
        row(GS_OTHER_USER, OTHER_USER, { blockGenerationSourceAppId: APP }),
        row(GS_OTHER_APP, VIEWER, { blockGenerationSourceAppId: OTHER_APP }),
        row(
          GS_PENDING_OWN,
          VIEWER,
          { blockGenerationSourceAppId: APP },
          { nsfwLevel: 0, ingestion: 'Pending' }
        ),
        row(
          GS_PENDING_OTHER_USER,
          OTHER_USER,
          { blockGenerationSourceAppId: APP },
          { nsfwLevel: 0, ingestion: 'Pending' }
        ),
        row(GS_FLAGGED_OWN, VIEWER, { blockGenerationSourceAppId: APP }, { needsReview: 'poi' }),
        row(
          GS_SCAN_BLOCKED_OWN,
          VIEWER,
          { blockGenerationSourceAppId: APP },
          { nsfwLevel: 0, ingestion: 'Blocked' }
        ),
        row(GS_MATURE_OWN, VIEWER, { blockGenerationSourceAppId: APP }, { nsfwLevel: MATURE }),
        row(GS_POSTED_OWN, VIEWER, { blockGenerationSourceAppId: APP }, { postId: 9 }),
        row(GS_HIDDEN_TAG_OWN, VIEWER, { blockGenerationSourceAppId: APP }),
        row(PUBLISHED_AND_GS_OTHER_USER, OTHER_USER, {
          blockPublishedAppId: APP,
          blockGenerationSourceAppId: APP,
        }),
      ].join(',\n')};
    INSERT INTO "Image" (id, "userId", url, "nsfwLevel", metadata, "modelRestricted", "blockedFor") VALUES
      (${GS_RESTRICTED_OWN}, ${VIEWER}, 'key-${GS_RESTRICTED_OWN}', ${MATURE},
        '{"blockGenerationSourceAppId":"${APP}"}'::jsonb, true, NULL),
      (${GS_HARD_BLOCKED_OWN}, ${VIEWER}, 'key-${GS_HARD_BLOCKED_OWN}', ${BROWSING},
        '{"blockGenerationSourceAppId":"${APP}"}'::jsonb, false, 'moderated');
    INSERT INTO "TagsOnImageDetails" ("imageId", "tagId", disabled) VALUES
      (${GS_HIDDEN_TAG_OWN}, ${HIDDEN_TAG}, false);
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

describe('gated read: a PRIVATE generation source resolves for its own author, on its own app, only', () => {
  it('POSITIVE CONTROL: returns the viewer’s own scanned source with the moderated projection', async () => {
    const { images } = await gatedRead([GS_OWN]);
    expect(images).toEqual([
      {
        imageId: GS_OWN,
        status: 'visible',
        nsfwLevel: BROWSING,
        contentRating: expect.any(String),
        url: `edge:key-${GS_OWN}`,
        width: null,
        height: null,
      },
    ]);
  });

  it('🔴 (owner) another user’s source on the same app is omitted, and never leaves Postgres', async () => {
    // The published row asked for in the same call is the positive control that the read ran.
    const { images } = await gatedRead([
      GS_OTHER_USER,
      GS_PENDING_OTHER_USER,
      PUBLISHED_OTHER_USER,
    ]);
    expect(images.map((i) => i.imageId)).toEqual([PUBLISHED_OTHER_USER]);
    expect(holder.lastRows.map((r) => r.id)).toEqual([PUBLISHED_OTHER_USER]);
  });

  it('🔴 (owner) the viewer’s own source is omitted when ANOTHER user asks for it', async () => {
    // That user's own source, asked for in the same call, is the positive control.
    const other = await gatedReadAs([GS_OWN, GS_PENDING_OWN, GS_OTHER_USER], {
      userId: OTHER_USER,
    });
    expect(other.images.map((i) => i.imageId)).toEqual([GS_OTHER_USER]);
  });

  it('🔴 (same app) a source kept by another app is omitted, both ways', async () => {
    const { images } = await gatedRead([GS_OTHER_APP, GS_OWN]);
    expect(images.map((i) => i.imageId)).toEqual([GS_OWN]);
    expect(holder.lastRows.map((r) => r.id)).toEqual([GS_OWN]);
    // OTHER_APP cannot read APP's source; its own source is the positive control.
    const other = await gatedReadAs([GS_OWN, GS_OTHER_APP], { appId: OTHER_APP });
    expect(other.images.map((i) => i.imageId)).toEqual([GS_OTHER_APP]);
  });

  it('🔴 (unrated) the author gets ratingPending: a url and no rating claim', async () => {
    const { images } = await gatedRead([GS_PENDING_OWN]);
    expect(images).toEqual([
      {
        imageId: GS_PENDING_OWN,
        status: 'visible',
        ratingPending: true,
        url: `edge:key-${GS_PENDING_OWN}`,
        width: null,
        height: null,
      },
    ]);
  });

  it('🔴 (unrated) any other user gets nothing for it: no url, no hidden entry', async () => {
    const other = await gatedReadAs([GS_PENDING_OWN, GS_PENDING_OTHER_USER], {
      userId: OTHER_USER,
    });
    expect(other.images).toEqual([
      expect.objectContaining({ imageId: GS_PENDING_OTHER_USER, ratingPending: true }),
    ]);
  });

  it.each([
    ['held for review', GS_FLAGGED_OWN],
    ['refused by the scanner', GS_SCAN_BLOCKED_OWN],
    ['hard-blocked by moderation', GS_HARD_BLOCKED_OWN],
    ['above the viewer’s ceiling', GS_MATURE_OWN],
    ['already in a post (`postId IS NULL`)', GS_POSTED_OWN],
  ])('🔴 (blocked or held) the author’s own source %s is omitted, not hidden', async (_l, id) => {
    const { images } = await gatedRead([id, GS_OWN]);
    expect(images.map((i) => i.imageId)).toEqual([GS_OWN]);
  });

  it('🔴 (blocked) a restricted source is omitted for its author, where a published one is shown', async () => {
    // The published restricted row is shown to its uploader (the block above); a private source
    // gets no uploader exception. The R source alongside proves the ceiling admits the level.
    const { images } = await gatedReadAs([GS_RESTRICTED_OWN, GS_MATURE_OWN], {
      browsingLevel: R_ALLOWED,
    });
    expect(images).toEqual([
      expect.objectContaining({ imageId: GS_MATURE_OWN, status: 'visible', nsfwLevel: MATURE }),
    ]);
  });

  it('🔴 (blocked tags) a source carrying a tag the viewer hides is omitted', async () => {
    expect((await gatedRead([GS_HIDDEN_TAG_OWN])).images.map((i) => i.imageId)).toEqual([
      GS_HIDDEN_TAG_OWN,
    ]);
    holder.hiddenTagIds = [HIDDEN_TAG];
    const { images } = await gatedRead([GS_HIDDEN_TAG_OWN, GS_OWN]);
    expect(images.map((i) => i.imageId)).toEqual([GS_OWN]);
  });

  it('REGRESSION: a row with BOTH the published and the generation-source key keeps the published rules for a non-author', async () => {
    const { images } = await gatedRead([PUBLISHED_AND_GS_OTHER_USER]);
    expect(images).toEqual([
      expect.objectContaining({ imageId: PUBLISHED_AND_GS_OTHER_USER, status: 'visible' }),
    ]);
  });

  it('REGRESSION: a bytes upload is still never returned, alongside a resolving source', async () => {
    const { images } = await gatedRead([UPLOADED_OWN, UPLOADED_OTHER_USER, GS_OWN]);
    expect(images.map((i) => i.imageId)).toEqual([GS_OWN]);
  });

  it('a source is still not postable', async () => {
    await expectNotPostable(GS_OWN);
  });
});
