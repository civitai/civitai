import { describe, expect, it } from 'vitest';
import {
  classifyStampedPost,
  planRepair,
  type StampedPostRow,
} from '~/server/utils/post-unpublished-stamp-repair';

const published = new Date('2024-05-05T14:18:00.000Z');
const later = new Date('2024-05-05T15:03:00.000Z');
const earlier = new Date('2024-05-01T00:00:00.000Z');

const row = (overrides: Partial<StampedPostRow> = {}): StampedPostRow => ({
  id: 1,
  publishedAt: published,
  unpublishedAt: later,
  userId: 10,
  modelVersionId: 100,
  versionStatus: 'Unpublished',
  modelStatus: 'Unpublished',
  modelUserId: 10,
  ...overrides,
});

describe('classifyStampedPost', () => {
  it('calls a post unpublished after publishing, with its parent down, an orphan', () => {
    expect(classifyStampedPost(row())).toBe('orphan');
  });

  it('calls a post an orphan when only one of version and model is Published', () => {
    expect(classifyStampedPost(row({ versionStatus: 'Published' }))).toBe('orphan');
    expect(classifyStampedPost(row({ modelStatus: 'Published' }))).toBe('orphan');
  });

  it('keeps a post of a live model out of the orphans', () => {
    // Clearing publishedAt here would turn the public post of a published model into a draft.
    const live = row({ versionStatus: 'Published', modelStatus: 'Published' });
    expect(classifyStampedPost(live)).toBe('liveParent');
  });

  it('calls a post stamped before its publishedAt republished, whatever the parent', () => {
    expect(classifyStampedPost(row({ unpublishedAt: earlier }))).toBe('republished');
    expect(
      classifyStampedPost(
        row({ unpublishedAt: earlier, versionStatus: 'Published', modelStatus: 'Published' })
      )
    ).toBe('republished');
    expect(classifyStampedPost(row({ unpublishedAt: earlier, modelVersionId: null }))).toBe(
      'republished'
    );
  });

  it('leaves identical timestamps in a bucket of their own', () => {
    expect(classifyStampedPost(row({ unpublishedAt: new Date(published) }))).toBe('equal');
  });

  it('calls a post outside the unpublish cascade scope detached', () => {
    expect(classifyStampedPost(row({ modelVersionId: null }))).toBe('detached');
    expect(classifyStampedPost(row({ modelUserId: null, versionStatus: null }))).toBe('detached');
    expect(classifyStampedPost(row({ modelUserId: 11 }))).toBe('detached');
    expect(
      classifyStampedPost(
        row({ modelUserId: 11, versionStatus: 'Published', modelStatus: 'Published' })
      )
    ).toBe('detached');
  });
});

describe('planRepair', () => {
  const rows = [
    row({ id: 1 }),
    row({ id: 2, unpublishedAt: earlier }),
    row({ id: 3, versionStatus: 'Published', modelStatus: 'Published' }),
    row({ id: 4, modelVersionId: null }),
    row({ id: 5, unpublishedAt: new Date(published) }),
  ];

  it('touches only orphans and republished posts by default', () => {
    const plan = planRepair(rows, { liveParent: 'skip', detached: 'skip' });

    expect(plan.clear).toEqual([1]);
    expect(plan.strip).toEqual([2]);
    expect(plan.skipped).toEqual([3, 4, 5]);
    expect(plan.buckets).toEqual({
      orphan: [1],
      republished: [2],
      liveParent: [3],
      detached: [4],
      equal: [5],
    });
  });

  it('applies the chosen action to each undecided bucket independently', () => {
    const plan = planRepair(rows, { liveParent: 'strip', detached: 'clear' });

    expect(plan.clear).toEqual([1, 4]);
    expect(plan.strip).toEqual([2, 3]);
    expect(plan.skipped).toEqual([5]);
  });

  it('puts every row in exactly one of clear, strip and skipped', () => {
    const plan = planRepair(rows, { liveParent: 'clear', detached: 'strip' });

    expect([...plan.clear, ...plan.strip, ...plan.skipped].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
