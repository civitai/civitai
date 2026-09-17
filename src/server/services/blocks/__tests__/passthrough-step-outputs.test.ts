import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * OUTPUT coverage for the PASS-THROUGH arm (`kind:'step'` with a bare `$type`).
 *
 * 🔴 THE PROPERTY UNDER TEST IS A NEGATIVE ONE, AND IT IS THE WHOLE POINT. The
 * arm forwards an arbitrary orchestrator output to the block, so the question is
 * not "does the output arrive" but "can an image url arrive by a route the
 * publish path and the per-viewer gated read do not see". Every assertion below
 * is either (a) the blobs landed on `imageUrls` / `AppWorkflow.images` — the one
 * channel those two already own — or (b) they did NOT land in `stepOutputs`.
 */

// Deterministic edge-url so the gated assertions are stable and the real CF util
// (which pulls env) stays out. Mirrors `block-gated-images.service.test.ts`.
vi.mock('~/client-utils/edge-url', () => ({
  getEdgeUrl: (url: string, opts?: { width?: number }) => `edge:${url}@${opts?.width}`,
}));
const getAllHiddenForUser = vi.fn(async () => ({
  hiddenUsers: [] as Array<{ id: number }>,
  blockedUsers: [] as Array<{ id: number }>,
  blockedByUsers: [] as Array<{ id: number }>,
  hiddenTags: [] as Array<{ id: number; hidden: boolean }>,
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  getAllHiddenForUser: (...a: unknown[]) => getAllHiddenForUser(...(a as [])),
}));
vi.mock('~/server/services/blocks/block-image-upload.service', () => ({
  BLOCK_PUBLISHED_APP_ID_META_KEY: 'blockPublishedAppId',
}));

import { projectAppWorkflow, snapshotFromWorkflow } from '../workflow.service';
import { splitPassThroughStepOutput } from '../steps';
import { getBlockGatedImagesByIds } from '../block-gated-images.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/** A `$type` the step registry does not know and `workflow.service` does not
 *  extract natively — i.e. reachable ONLY through the pass-through arm. */
const PASS_THROUGH_TYPE = 'textToImageV2';

const BLOB_URL = 'https://blobs.example/pass-through-1.webp';

function workflowWithPassThroughStep(output: unknown) {
  return {
    id: 'wf_pt_1',
    status: 'succeeded',
    createdAt: '2026-09-17T00:00:00Z',
    cost: { total: 7 },
    steps: [{ $type: PASS_THROUGH_TYPE, output }],
  };
}

describe('splitPassThroughStepOutput', () => {
  it('lifts blobs out and leaves everything else verbatim', () => {
    const { media, rest } = splitPassThroughStepOutput({
      blobs: [{ url: BLOB_URL, available: true, width: 10, height: 20, nsfwLevel: 'pg' }],
      text: 'a reply',
      nested: { a: [1, 2] },
    });
    expect(media).toEqual([{ url: BLOB_URL, width: 10, height: 20, nsfwLevel: 'pg' }]);
    expect(rest).toEqual({ text: 'a reply', nested: { a: [1, 2] } });
  });

  // 🔴 THE STRIP IS UNCONDITIONAL. A blob that the availability filter DROPPED
  // must not survive in `rest` — filtering and stripping on the same predicate is
  // how a blocked url reaches a block through the back door.
  it('strips a blob key that produced NO media', () => {
    const { media, rest } = splitPassThroughStepOutput({
      blobs: [{ url: BLOB_URL, available: false }],
      note: 'kept',
    });
    expect(media).toEqual([]);
    expect(rest).toEqual({ note: 'kept' });
    expect(JSON.stringify(rest)).not.toContain(BLOB_URL);
  });

  it('handles the SINGULAR `blob` key and a non-object output', () => {
    expect(
      splitPassThroughStepOutput({ blob: { url: BLOB_URL, available: true } }).media
    ).toHaveLength(1);
    expect(splitPassThroughStepOutput('just text')).toEqual({ media: [], rest: 'just text' });
    expect(splitPassThroughStepOutput(undefined)).toEqual({ media: [], rest: undefined });
  });
});

describe('snapshotFromWorkflow — pass-through step', () => {
  it('routes image blobs to imageUrls and forwards the REST as stepOutputs', () => {
    const snap = snapshotFromWorkflow(
      workflowWithPassThroughStep({
        blobs: [{ url: BLOB_URL, available: true }],
        text: 'a model reply',
      }) as never
    );
    expect(snap.imageUrls).toEqual([BLOB_URL]);
    expect(snap.stepOutputs).toEqual([
      { $type: PASS_THROUGH_TYPE, output: { text: 'a model reply' } },
    ]);
    // 🔴 THE NEGATIVE HALF: no second image channel.
    expect(JSON.stringify(snap.stepOutputs)).not.toContain(BLOB_URL);
  });

  it('forwards a non-media output whole', () => {
    const snap = snapshotFromWorkflow(
      workflowWithPassThroughStep({ text: 'hello', tokens: { in: 3, out: 9 } }) as never
    );
    expect(snap.imageUrls).toBeUndefined();
    expect(snap.stepOutputs).toEqual([
      { $type: PASS_THROUGH_TYPE, output: { text: 'hello', tokens: { in: 3, out: 9 } } },
    ]);
  });

  // A fresh submit reply carries steps with no `output` at all. An entry there
  // would say nothing and would appear on EVERY pass-through submit reply.
  it('OMITS stepOutputs for a step that has produced nothing yet', () => {
    const snap = snapshotFromWorkflow({
      id: 'wf_pt_new',
      status: 'processing',
      steps: [{ $type: PASS_THROUGH_TYPE }],
    } as never);
    expect(snap.stepOutputs).toBeUndefined();
  });

  it('KEEPS an entry for an empty-object output (distinct from absent)', () => {
    const snap = snapshotFromWorkflow(workflowWithPassThroughStep({}) as never);
    expect(snap.stepOutputs).toEqual([{ $type: PASS_THROUGH_TYPE, output: {} }]);
  });

  // Additive-by-construction: the field must be ABSENT for every body that
  // existed before this arm, or an SDK validator sees a shape change on a
  // snapshot nothing about this change touched.
  it('OMITS stepOutputs for a native textToImage workflow', () => {
    const snap = snapshotFromWorkflow({
      id: 'wf_t2i',
      status: 'succeeded',
      steps: [
        { $type: 'textToImage', output: { images: [{ url: 'https://i/x.png', available: true }] } },
      ],
    } as never);
    expect(snap.imageUrls).toEqual(['https://i/x.png']);
    expect(snap.stepOutputs).toBeUndefined();
  });

  it('OMITS stepOutputs for a native customComfy workflow', () => {
    const snap = snapshotFromWorkflow({
      id: 'wf_cc',
      status: 'succeeded',
      steps: [
        { $type: 'customComfy', output: { blobs: [{ url: 'https://i/c.png', available: true }] } },
      ],
    } as never);
    expect(snap.imageUrls).toEqual(['https://i/c.png']);
    expect(snap.stepOutputs).toBeUndefined();
  });
});

describe('projectAppWorkflow — pass-through step', () => {
  // 🔴 THIS IS THE PUBLISHABILITY HALF OF THE GATED-IMAGE CHAIN.
  // `resolveOwnedWorkflowOutputs` reads THIS projection, so a pass-through image
  // missing here is one a viewer can see in their own block and can never
  // publish — which routes it AROUND the per-viewer gated read rather than
  // through it.
  it('surfaces pass-through blobs as AppWorkflow images, with the rest dropped', () => {
    const projected = projectAppWorkflow(
      workflowWithPassThroughStep({
        blobs: [{ url: BLOB_URL, available: true, width: 64, height: 48, nsfwLevel: 'pg13' }],
        text: 'not an image',
      }) as never
    );
    expect(projected.images).toEqual([
      { url: BLOB_URL, width: 64, height: 48, nsfwLevel: NsfwLevel.PG13 },
    ]);
    // `AppWorkflow` is the queue contract — images, cost, status and nothing else.
    expect(Object.keys(projected).sort()).toEqual(
      ['cost', 'createdAt', 'images', 'status', 'workflowId'].sort()
    );
  });

  it('drops an unavailable pass-through blob rather than handing over a dead link', () => {
    const projected = projectAppWorkflow(
      workflowWithPassThroughStep({ blobs: [{ url: BLOB_URL, available: false }] }) as never
    );
    expect(projected.images).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The far end of the chain: once a pass-through output is PUBLISHED, a
// cross-viewer read of it is the ordinary gated read, and it must still clamp.
// ─────────────────────────────────────────────────────────────────────────────
describe('a published pass-through output is read back as BlockGatedImage', () => {
  const APP = 'app_test';
  const VIEWER = 42;
  const AUTHOR = 7;
  const SFW = NsfwLevel.PG | NsfwLevel.PG13;
  const PUBLISHED_ID = 9001;

  /** The `Image` row `publishGenerationOutputs` writes for a pass-through blob. */
  const publishedRow = (over: Record<string, unknown> = {}) => ({
    id: PUBLISHED_ID,
    userId: AUTHOR,
    url: `key-${PUBLISHED_ID}`,
    nsfwLevel: NsfwLevel.PG,
    ingestion: ImageIngestionStatus.Scanned,
    width: 512,
    height: 512,
    needsReview: null,
    poi: false,
    minor: false,
    tosViolation: false,
    acceptableMinor: false,
    blockedFor: null,
    ...over,
  });

  beforeEach(() => {
    dbMock.dbRead.$queryRaw.mockReset();
    getAllHiddenForUser.mockClear();
  });

  it('yields a VISIBLE BlockGatedImage (an edge url, never the raw key) in-ceiling', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([publishedRow()]);
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [PUBLISHED_ID],
      browsingLevel: SFW,
      appId: APP,
      userId: VIEWER,
    });
    expect(images).toEqual([
      {
        imageId: PUBLISHED_ID,
        status: 'visible',
        nsfwLevel: NsfwLevel.PG,
        contentRating: expect.anything(),
        // The gated EDGE url (1200 = the service's own GATED_IMAGE_EDGE_WIDTH,
        // module-private), never the raw storage key.
        url: `edge:key-${PUBLISHED_ID}@1200`,
        width: 512,
        height: 512,
      },
    ]);
  });

  // 🔴 THE OVER-CEILING VIEWER. `hidden` and NO url — the per-viewer moderation
  // boundary the pass-through arm must not route around.
  it('yields HIDDEN with no url for an over-ceiling viewer', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([publishedRow({ nsfwLevel: NsfwLevel.X })]);
    const { images } = await getBlockGatedImagesByIds({
      imageIds: [PUBLISHED_ID],
      browsingLevel: SFW,
      appId: APP,
      userId: VIEWER,
    });
    expect(images).toEqual([{ imageId: PUBLISHED_ID, status: 'hidden' }]);
    expect(JSON.stringify(images)).not.toContain(`key-${PUBLISHED_ID}`);
  });
});
