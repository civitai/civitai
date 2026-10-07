import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  getRatingReviewScan,
  loadRatingReviewSubject,
} from '~/server/services/rating-review.entities';

const at = new Date('2026-09-01T00:00:00Z');
const textScan = (level: string, textHash = 'h') => ({
  version: 1,
  textHash,
  labels: { nsfw: { level, reason: 'fake reason' } },
});

beforeEach(() => {
  dbMock.dbRead.post.findUnique.mockResolvedValue(null);
  dbMock.dbRead.entityModeration.findUnique.mockResolvedValue(null);
});

describe('loadRatingReviewSubject', () => {
  it('reads a bitmask level as its highest set bit and carries the override pair', async () => {
    dbMock.dbRead.post.findUnique.mockResolvedValue({
      userId: 3,
      nsfwLevel: 5,
      updatedAt: at,
      title: null,
      moderatorNsfwLevel: 4,
      moderatorNsfwLevelBasis: 8,
    });
    expect(await loadRatingReviewSubject('Post', 7)).toEqual({
      ownerId: 3,
      currentLevel: 4,
      updatedAt: at,
      title: 'Post #7',
      parentId: null,
      override: 4,
      overrideBasis: 8,
    });
  });

  it('maps a model to SFW/NSFW from its flag, gives it no override, and hides a deleted model', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValueOnce({
      userId: 3,
      nsfw: true,
      updatedAt: at,
      name: 'm',
      deletedAt: null,
    });
    expect(await loadRatingReviewSubject('Model', 1)).toMatchObject({
      currentLevel: 4,
      override: null,
      overrideBasis: null,
    });
    dbMock.dbRead.model.findUnique.mockResolvedValueOnce({
      userId: 3,
      nsfw: false,
      updatedAt: at,
      name: 'm',
      deletedAt: null,
    });
    expect((await loadRatingReviewSubject('Model', 1))?.currentLevel).toBe(1);
    dbMock.dbRead.model.findUnique.mockResolvedValueOnce({
      userId: 3,
      nsfw: true,
      updatedAt: at,
      name: 'm',
      deletedAt: at,
    });
    expect(await loadRatingReviewSubject('Model', 1)).toBeNull();
  });

  it('marks a poi or minor model restricted, but not one its creator made SFW-only', async () => {
    const row = {
      userId: 3,
      nsfw: false,
      updatedAt: at,
      name: 'm',
      deletedAt: null,
      poi: false,
      minor: false,
    };
    for (const flag of ['poi', 'minor'] as const) {
      dbMock.dbRead.model.findUnique.mockResolvedValueOnce({ ...row, [flag]: true });
      expect((await loadRatingReviewSubject('Model', 1))?.disputeRestriction).toMatch(
        /while the flag stands/
      );
    }
    dbMock.dbRead.model.findUnique.mockResolvedValueOnce({ ...row, sfwOnly: true });
    expect((await loadRatingReviewSubject('Model', 1))?.disputeRestriction).toBeUndefined();
  });

  it('gives a system challenge no owner and a user challenge its creator', async () => {
    const row = {
      createdById: 9,
      nsfwLevel: 4,
      updatedAt: at,
      title: 't',
      moderatorNsfwLevel: null,
      moderatorNsfwLevelBasis: null,
    };
    dbMock.dbRead.challenge.findUnique.mockResolvedValueOnce({ ...row, source: 'System' });
    expect((await loadRatingReviewSubject('Challenge', 1))?.ownerId).toBeNull();
    dbMock.dbRead.challenge.findUnique.mockResolvedValueOnce({ ...row, source: 'User' });
    expect((await loadRatingReviewSubject('Challenge', 1))?.ownerId).toBe(9);
  });

  it('Crucible subject: owner, highest rated bit, override pair', async () => {
    dbMock.dbRead.crucible.findUnique.mockResolvedValue({
      userId: 9,
      nsfwLevel: 1 | 4,
      updatedAt: new Date(0),
      name: 'C',
      moderatorNsfwLevel: null,
      moderatorNsfwLevelBasis: null,
    });
    expect(await loadRatingReviewSubject('Crucible', 1)).toMatchObject({
      ownerId: 9,
      currentLevel: 4,
      title: 'C',
    });
  });

  it('Collection subject: bucket read as PG or R', async () => {
    const row = {
      userId: 9,
      nsfwLevel: 29,
      updatedAt: new Date(0),
      name: 'L',
      moderatorNsfwLevel: null,
      moderatorNsfwLevelBasis: null,
    };
    dbMock.dbRead.collection.findUnique.mockResolvedValueOnce(row);
    expect(await loadRatingReviewSubject('Collection', 1)).toMatchObject({ currentLevel: 4 });
    dbMock.dbRead.collection.findUnique.mockResolvedValueOnce({ ...row, nsfwLevel: 1 });
    expect(await loadRatingReviewSubject('Collection', 1)).toMatchObject({ currentLevel: 1 });
  });

  it('restricts disputes on a collection with a forced level', async () => {
    const row = {
      userId: 9,
      nsfwLevel: 1,
      updatedAt: new Date(0),
      name: 'L',
      moderatorNsfwLevel: null,
      moderatorNsfwLevelBasis: null,
    };
    dbMock.dbRead.collection.findUnique.mockResolvedValueOnce({
      ...row,
      metadata: { forcedBrowsingLevel: 3 },
    });
    expect((await loadRatingReviewSubject('Collection', 1))?.disputeRestriction).toMatch(
      /can't be disputed/
    );
    dbMock.dbRead.collection.findUnique.mockResolvedValueOnce({ ...row, metadata: {} });
    expect((await loadRatingReviewSubject('Collection', 1))?.disputeRestriction).toBeUndefined();
  });

  it('carries the bounty id of an entry', async () => {
    dbMock.dbRead.bountyEntry.findUnique.mockResolvedValue({
      userId: 3,
      bountyId: 44,
      nsfwLevel: 4,
      updatedAt: at,
      moderatorNsfwLevel: null,
      moderatorNsfwLevelBasis: null,
    });
    expect(await loadRatingReviewSubject('BountyEntry', 8)).toMatchObject({
      parentId: 44,
      title: 'Entry #8',
    });
  });

  it('never reports Blocked as the current rating: an nsfw bounty stores R|X|XXX|Blocked', async () => {
    dbMock.dbRead.bounty.findUnique.mockResolvedValue({
      userId: 3,
      nsfwLevel: 60,
      updatedAt: at,
      name: 'b',
      moderatorNsfwLevel: null,
      moderatorNsfwLevelBasis: null,
    });
    expect(await loadRatingReviewSubject('Bounty', 9)).toMatchObject({ currentLevel: 16 });
  });

  it('returns null for a missing row', async () => {
    expect(await loadRatingReviewSubject('Post', 404)).toBeNull();
  });
});

describe('getRatingReviewScan', () => {
  it('reports a raise, its reason and the scan text hash from the live row', async () => {
    dbMock.dbRead.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      nsfwLevel: 8,
      result: textScan('x', 'h1'),
      contentHash: 'composed-request-hash',
    });
    expect(await getRatingReviewScan('Post', 1)).toEqual({
      raised: true,
      level: 8,
      reason: 'fake reason',
      textHash: 'h1',
      pending: false,
    });
    expect(dbMock.dbRead.entityModeration.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType_entityId: { entityType: 'Post', entityId: 1 } },
      })
    );
  });

  it("stays raised on the rescan after the floor lifted the declared level, keeping the last completed scan's text hash", async () => {
    // The floor raised the post to X, so the rescan declares X and triggers nothing; the row still holds X.
    dbMock.dbRead.entityModeration.findUnique.mockResolvedValue({
      status: 'Pending',
      triggeredLabels: [],
      nsfwLevel: 8,
      result: textScan('x', 'h2'),
      contentHash: 'h-being-scanned',
    });
    expect(await getRatingReviewScan('Post', 1)).toMatchObject({
      raised: true,
      pending: true,
      textHash: 'h2',
    });
  });

  it('never counts an XGuard row, whatever it triggered', async () => {
    dbMock.dbRead.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      triggeredLabels: ['nsfw'],
      nsfwLevel: null,
      result: { labels: [{ label: 'nsfw', score: 0.9 }] },
      contentHash: 'h3',
    });
    expect(await getRatingReviewScan('Article', 1)).toEqual({
      raised: false,
      level: null,
      reason: null,
      textHash: null,
      pending: false,
    });
  });

  it('needs R or above to raise a model, and a PG verdict never raises anything', async () => {
    dbMock.dbRead.entityModeration.findUnique.mockResolvedValueOnce({
      status: 'Succeeded',
      nsfwLevel: 2,
      result: textScan('pg13'),
    });
    expect((await getRatingReviewScan('Model', 1))?.raised).toBe(false);
    dbMock.dbRead.entityModeration.findUnique.mockResolvedValueOnce({
      status: 'Succeeded',
      nsfwLevel: 4,
      result: textScan('r'),
    });
    expect((await getRatingReviewScan('Model', 1))?.raised).toBe(true);
    dbMock.dbRead.entityModeration.findUnique.mockResolvedValueOnce({
      status: 'Succeeded',
      nsfwLevel: 1,
      result: textScan('pg'),
    });
    expect((await getRatingReviewScan('Post', 1))?.raised).toBe(false);
  });

  it('returns null when the entity has no scan row', async () => {
    expect(await getRatingReviewScan('Bounty', 1)).toBeNull();
  });
});
