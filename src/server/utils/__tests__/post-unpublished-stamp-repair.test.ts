import { describe, expect, it } from 'vitest';
import {
  classifyStampedPost,
  planRepair,
  type BucketActions,
  type StampedPostRow,
} from '~/server/utils/post-unpublished-stamp-repair';

const now = new Date('2026-09-29T00:00:00.000Z');
const published = new Date('2024-05-05T14:18:00.000Z');
const later = new Date('2024-05-05T15:03:00.000Z');
const earlier = new Date('2024-05-01T00:00:00.000Z');

const row = (overrides: Partial<StampedPostRow> = {}): StampedPostRow => ({
  id: 1,
  publishedAt: published,
  unpublishedAt: later,
  updatedAt: earlier,
  userId: 10,
  stampedByOwner: true,
  modelVersionId: 100,
  versionStatus: 'Unpublished',
  modelStatus: 'Unpublished',
  modelUserId: 10,
  ...overrides,
});
const live = { versionStatus: 'Published', modelStatus: 'Published' };
const classify = (overrides: Partial<StampedPostRow> = {}) =>
  classifyStampedPost(row(overrides), now);

describe('classifyStampedPost', () => {
  it('puts the owner’s post on a version that is down in parentDown', () => {
    expect(classify()).toBe('parentDown');
    expect(classify({ versionStatus: 'Deleted', modelStatus: 'Deleted' })).toBe('parentDown');
  });

  it('keeps a post under a published model in parentDown while its version is down', () => {
    expect(classify({ modelStatus: 'Published' })).toBe('parentDown');
  });

  it('does not take a stamp older than publishedAt as a republish', () => {
    // A post scheduled when its model was deleted has one too, and nobody republished it.
    expect(classify({ unpublishedAt: earlier, updatedAt: earlier })).toBe('parentDown');
    expect(classify({ unpublishedAt: earlier, updatedAt: earlier, modelVersionId: null })).toBe(
      'detached'
    );
  });

  it('never calls a post stamped by someone else ownerEdited', () => {
    expect(classify({ unpublishedAt: earlier, updatedAt: later, stampedByOwner: false })).toBe(
      'parentDown'
    );
  });

  it('calls a post ownerEdited only when the owner stamped it and edited it afterwards', () => {
    expect(classify({ unpublishedAt: earlier, updatedAt: later })).toBe('ownerEdited');
    expect(classify({ unpublishedAt: earlier, updatedAt: later, modelVersionId: null })).toBe(
      'ownerEdited'
    );
  });

  it('ignores an updatedAt within five seconds of the stamp', () => {
    const justAfter = new Date(earlier.getTime() + 5_000);
    expect(classify({ unpublishedAt: earlier, updatedAt: justAfter })).toBe('parentDown');
  });

  it('ignores an edit on a post stamped after publishing', () => {
    expect(classify({ updatedAt: new Date('2025-01-01T00:00:00.000Z') })).toBe('parentDown');
  });

  it('calls the owner’s post liveParent only when version and model are both Published', () => {
    expect(classify(live)).toBe('liveParent');
    expect(classify({ ...live, unpublishedAt: earlier, updatedAt: later })).toBe('liveParent');
  });

  it('calls a published version under a model that is down halfLive', () => {
    expect(classify({ versionStatus: 'Published' })).toBe('halfLive');
  });

  it('sends a post under a moderator takedown to parentDown ahead of every strip bucket', () => {
    const takenDown = { modelStatus: 'UnpublishedViolation' };
    expect(classify({ ...takenDown, versionStatus: 'Published' })).toBe('parentDown');
    expect(classify({ ...takenDown, unpublishedAt: earlier, updatedAt: later })).toBe('parentDown');
    expect(classify({ ...takenDown, publishedAt: new Date('2026-10-10T00:00:00.000Z') })).toBe(
      'parentDown'
    );
    expect(classify({ versionStatus: 'UnpublishedViolation', modelStatus: 'Published' })).toBe(
      'parentDown'
    );
  });

  it('calls a post outside the unpublish cascade scope detached, even under a live model', () => {
    expect(classify({ modelVersionId: null })).toBe('detached');
    expect(classify({ modelUserId: null, versionStatus: null, modelStatus: null })).toBe(
      'detached'
    );
    expect(classify({ ...live, modelUserId: 11 })).toBe('detached');
  });

  it('calls a post whose publishedAt has not come yet scheduled, whatever else is true', () => {
    const future = new Date('2026-10-10T00:00:00.000Z');
    expect(classify({ publishedAt: future })).toBe('scheduled');
    expect(classify({ ...live, publishedAt: future })).toBe('scheduled');
    expect(classify({ publishedAt: future, modelVersionId: null })).toBe('scheduled');
  });
});

describe('planRepair', () => {
  const rows = [
    row({ id: 1 }),
    row({ id: 2, modelVersionId: null }),
    row({ id: 3, ...live }),
    row({ id: 4, publishedAt: new Date('2026-10-10T00:00:00.000Z') }),
    row({ id: 5, versionStatus: 'Published' }),
    row({ id: 6, unpublishedAt: earlier, updatedAt: later }),
  ];
  const allStrip: BucketActions = {
    liveParent: 'strip',
    scheduled: 'strip',
    halfLive: 'strip',
    ownerEdited: 'strip',
  };

  it('always clears parentDown and detached, and keeps the live-parent strips apart', () => {
    const plan = planRepair(rows, allStrip, now);

    expect(plan.clear).toEqual([1, 2]);
    expect(plan.stripLive).toEqual([3]);
    expect(plan.stripForced).toEqual([4, 5, 6]);
    expect(plan.skipped).toEqual([]);
    expect(plan.buckets).toEqual({
      parentDown: [1],
      detached: [2],
      liveParent: [3],
      scheduled: [4],
      halfLive: [5],
      ownerEdited: [6],
    });
  });

  it('applies the chosen action to each undecided bucket independently', () => {
    const plan = planRepair(
      rows,
      { liveParent: 'skip', scheduled: 'clear', halfLive: 'strip', ownerEdited: 'strip' },
      now
    );

    expect(plan.clear).toEqual([1, 2, 4]);
    expect(plan.stripLive).toEqual([]);
    expect(plan.stripForced).toEqual([5, 6]);
    expect(plan.skipped).toEqual([3]);
  });

  it('puts every row in exactly one list', () => {
    const plan = planRepair(rows, { ...allStrip, halfLive: 'clear', scheduled: 'skip' }, now);

    expect([...plan.clear, ...plan.stripLive, ...plan.stripForced, ...plan.skipped].sort()).toEqual(
      [1, 2, 3, 4, 5, 6]
    );
  });
});
