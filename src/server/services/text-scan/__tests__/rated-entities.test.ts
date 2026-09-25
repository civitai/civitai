import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as NotifyModule from '~/server/services/text-scan/notify';

// Hand-listed: the real module builds Meilisearch clients and prom collectors at load.
vi.mock('~/server/services/nsfwLevels.service', () => ({
  updateArticleNsfwLevels: vi.fn(),
  updatePostNsfwLevels: vi.fn(),
  updateBountyNsfwLevels: vi.fn(),
  updateBountyEntryNsfwLevels: vi.fn(),
}));
vi.mock('~/server/services/text-scan/notify', async (importOriginal) => ({
  ...(await importOriginal<typeof NotifyModule>()),
  notifyTextScanRatingRaised: vi.fn(),
}));
// Hand-listed, as in challenge-moderation-adapter.test.ts: notify.ts imports it.
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

const { applyRatingFloor, recomputeRatedEntityNsfwLevel } = await import(
  '~/server/services/text-scan/rated-entities'
);
const { updatePostNsfwLevels, updateBountyNsfwLevels, updateBountyEntryNsfwLevels } = await import(
  '~/server/services/nsfwLevels.service'
);
const { notifyTextScanRatingRaised } = await import('~/server/services/text-scan/notify');

const args = (level: number, raised: boolean) => ({
  entityId: 7,
  workflowId: 'wf-1',
  outcome: {
    nsfw: { detectedLevel: level, declaredLevel: 1, raised, reason: 'r' },
    triggeredLabels: raised ? ['nsfw' as const] : [],
    nsfwLevel: level,
  },
  subject: { fields: [], declared: { nsfwLevel: 1 } },
});
const post = (nsfwLevel: number, over: Record<string, unknown> = {}) => ({
  nsfwLevel,
  moderatorNsfwLevel: null,
  userId: 5,
  title: 'My post',
  ...over,
});

beforeEach(() => vi.resetAllMocks());

describe('applyRatingFloor', () => {
  it('recomputes, and notifies once the effective level rises', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValueOnce(post(1)).mockResolvedValueOnce(post(4));
    await applyRatingFloor('Post', args(4, true));
    expect(updatePostNsfwLevels).toHaveBeenCalledWith([7]);
    expect(notifyTextScanRatingRaised).toHaveBeenCalledWith({
      entityType: 'Post',
      entityId: 7,
      userId: 5,
      level: 4,
      title: 'My post',
      url: '/posts/7',
      workflowId: 'wf-1',
    });
  });

  it('notifies when the raise drops the last SFW bit, even though the highest bit stays', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValueOnce(post(9)).mockResolvedValueOnce(post(8));
    await applyRatingFloor('Post', args(4, true));
    expect(notifyTextScanRatingRaised).toHaveBeenCalledWith(expect.objectContaining({ level: 8 }));
  });

  it('notifies when the raise drops any SFW bit', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValueOnce(post(11)).mockResolvedValueOnce(post(10));
    await applyRatingFloor('Post', args(2, true));
    expect(notifyTextScanRatingRaised).toHaveBeenCalledWith(expect.objectContaining({ level: 8 }));
  });

  it('names the level the entity now has, not the one the text was read at', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValueOnce(post(1)).mockResolvedValueOnce(post(8));
    await applyRatingFloor('Post', args(4, true));
    expect(notifyTextScanRatingRaised).toHaveBeenCalledWith(expect.objectContaining({ level: 8 }));
  });

  it('names the detected level for a bounty pinned by its nsfw flag', async () => {
    dbMock.dbWrite.bounty.findUnique
      .mockResolvedValueOnce({ nsfwLevel: 1, moderatorNsfwLevel: null, userId: 5, name: 'B' })
      .mockResolvedValueOnce({ nsfwLevel: 60, moderatorNsfwLevel: null, userId: 5, name: 'B' });
    await applyRatingFloor('Bounty', args(4, true));
    expect(notifyTextScanRatingRaised).toHaveBeenCalledWith(expect.objectContaining({ level: 4 }));
  });

  it('does not notify again when a redelivery or identical rescan changes nothing', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValue(post(4));
    await applyRatingFloor('Post', args(4, true));
    expect(updatePostNsfwLevels).toHaveBeenCalledWith([7]);
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });

  it('recomputes a cleaner verdict too, so the floor drops now', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValueOnce(post(4)).mockResolvedValueOnce(post(1));
    await applyRatingFloor('Post', args(1, false));
    expect(updatePostNsfwLevels).toHaveBeenCalledWith([7]);
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });

  it('recomputes but stays silent when the caller sends its own notice', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValueOnce(post(1)).mockResolvedValueOnce(post(4));
    await applyRatingFloor('Post', args(4, true), { notify: false });
    expect(updatePostNsfwLevels).toHaveBeenCalledWith([7]);
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });

  it('does not notify when a moderator override pins the level', async () => {
    dbMock.dbWrite.post.findUnique
      .mockResolvedValueOnce(post(1, { moderatorNsfwLevel: 1 }))
      .mockResolvedValueOnce(post(8, { moderatorNsfwLevel: 1 }));
    await applyRatingFloor('Post', args(8, true));
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });

  it.each([
    ['newly detects', { detected: true, declared: false, newlyDetected: true }],
    ['detects an already-declared', { detected: true, declared: true, newlyDetected: false }],
  ])(
    'recomputes a bounty and returns the notice instead of sending it when the scan %s poi',
    async (_, poi) => {
      dbMock.dbWrite.bounty.findUnique
        .mockResolvedValueOnce({ nsfwLevel: 1, moderatorNsfwLevel: null, userId: 5, name: 'B' })
        .mockResolvedValueOnce({ nsfwLevel: 4, moderatorNsfwLevel: null, userId: 5, name: 'B' });
      const withPoi = args(4, true);
      const result = await applyRatingFloor('Bounty', {
        ...withPoi,
        outcome: { ...withPoi.outcome, poi: { ...poi, names: ['A'], reason: 'r' } },
      });
      expect(updateBountyNsfwLevels).toHaveBeenCalledWith([7]);
      expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
      expect(result).toEqual({
        deferredRatingNotice: {
          entityType: 'Bounty',
          entityId: 7,
          userId: 5,
          level: 4,
          title: 'B',
          url: '/bounties/7',
          workflowId: 'wf-1',
        },
      });
    }
  );

  it('defers nothing when no notice was due', async () => {
    dbMock.dbWrite.bounty.findUnique.mockResolvedValue({
      nsfwLevel: 4,
      moderatorNsfwLevel: null,
      userId: 5,
      name: 'B',
    });
    const withPoi = args(4, true);
    expect(
      await applyRatingFloor('Bounty', {
        ...withPoi,
        outcome: {
          ...withPoi.outcome,
          poi: { detected: true, declared: false, newlyDetected: true, names: ['A'], reason: 'r' },
        },
      })
    ).toEqual({ deferredRatingNotice: null });
  });

  it('does not notify when the floor could not rate an unrated entity', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValue(post(0));
    await applyRatingFloor('Post', args(4, true));
    expect(notifyTextScanRatingRaised).not.toHaveBeenCalled();
  });

  it('does nothing without an nsfw verdict', async () => {
    await applyRatingFloor('Post', {
      ...args(4, true),
      outcome: { triggeredLabels: [], nsfwLevel: null },
    });
    expect(dbMock.dbWrite.post.findUnique).not.toHaveBeenCalled();
    expect(updatePostNsfwLevels).not.toHaveBeenCalled();
  });

  it('does nothing for a deleted entity', async () => {
    dbMock.dbWrite.post.findUnique.mockResolvedValue(null);
    await applyRatingFloor('Post', args(4, true));
    expect(updatePostNsfwLevels).not.toHaveBeenCalled();
  });

  it('links a bounty entry under its bounty', async () => {
    dbMock.dbWrite.bountyEntry.findUnique
      .mockResolvedValueOnce({ nsfwLevel: 1, moderatorNsfwLevel: null, userId: 5, bountyId: 3 })
      .mockResolvedValueOnce({ nsfwLevel: 4, moderatorNsfwLevel: null, userId: 5, bountyId: 3 });
    await applyRatingFloor('BountyEntry', args(4, true));
    expect(updateBountyEntryNsfwLevels).toHaveBeenCalledWith([7]);
    expect(notifyTextScanRatingRaised).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/bounties/3/entries/7', title: null })
    );
  });
});

describe('recomputeRatedEntityNsfwLevel', () => {
  it('runs the entity recompute for one id', async () => {
    await recomputeRatedEntityNsfwLevel('Post', 9);
    expect(updatePostNsfwLevels).toHaveBeenCalledWith([9]);
  });
});
