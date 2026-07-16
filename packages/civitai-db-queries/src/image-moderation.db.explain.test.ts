import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteImageTagsForReview,
  getImageAppeal,
  getImageForBlock,
  getImageForModeration,
  getImagePostId,
  getImageTagsForReview,
  getPendingImageAppealAppellants,
  recomputeImageNsfwLevel,
  setImageAccepted,
  setImageAppealRejected,
  setImageAppealRestored,
  setImageAppealStatus,
  setImageBlocked,
  setImageNsfwLevel,
  setImageRatingRequestsResolved,
} from './image-moderation.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema — validates that the
// columns/joins/types/proc-signatures resolve against the real database without executing the statement
// (safe for the writes below). Skips when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('image-moderation queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getImageForModeration plans', async () => {
    await getImageForModeration(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImageForBlock plans', async () => {
    await getImageForBlock(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImagePostId plans', async () => {
    await getImagePostId(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImageTagsForReview plans', async () => {
    await getImageTagsForReview(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImageAppeal plans', async () => {
    await getImageAppeal(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getPendingImageAppealAppellants plans (guarded IN list)', async () => {
    await getPendingImageAppealAppellants(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageAccepted plans, default needsReview (write, not executed)', async () => {
    await setImageAccepted(h.db, { imageId: -1, needsReview: 'tag' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageAccepted plans, remixSource metadata merge (write, not executed)', async () => {
    await setImageAccepted(h.db, { imageId: -1, needsReview: 'remixSource' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageAccepted plans, minor CASE nsfwLevel (write, not executed)', async () => {
    await setImageAccepted(h.db, { imageId: -1, needsReview: 'minor' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteImageTagsForReview plans (write, not executed)', async () => {
    await deleteImageTagsForReview(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageBlocked plans (write, not executed)', async () => {
    await setImageBlocked(h.db, { imageId: -1, needsReview: 'tag' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageBlocked plans, remixSource metadata merge (write, not executed)', async () => {
    await setImageBlocked(h.db, { imageId: -1, needsReview: 'remixSource' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('recomputeImageNsfwLevel plans the stored-proc call (write, not executed)', async () => {
    await recomputeImageNsfwLevel(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageAppealStatus plans, no resolvedMessage (write, not executed)', async () => {
    await setImageAppealStatus(h.db, { imageId: -1, status: 'Approved', userId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageAppealStatus plans, with resolvedMessage (write, not executed)', async () => {
    await setImageAppealStatus(h.db, {
      imageId: -1,
      status: 'Rejected',
      userId: -1,
      resolvedMessage: null,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageAppealRestored plans (write, not executed)', async () => {
    await setImageAppealRestored(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageAppealRejected plans (write, not executed)', async () => {
    await setImageAppealRejected(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageNsfwLevel plans (write, not executed)', async () => {
    await setImageNsfwLevel(h.db, { id: -1, nsfwLevel: 0 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setImageRatingRequestsResolved plans (write, not executed)', async () => {
    await setImageRatingRequestsResolved(h.db, { imageId: -1, status: 'Actioned' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
