import { describe, expect, it } from 'vitest';
import { lastActionedBadge } from '../queue-thresholds';
import { needsAttention, type AttentionItem } from '../needs-attention';
import { navWorstRank } from '../nav-links';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

const IMAGE_REPORTS = 'report:image';

describe('lastActionedBadge', () => {
  it('goes from green to red as the last action ages', () => {
    expect(
      [0.5, 2, 12, 48, 100].map((h) => lastActionedBadge(IMAGE_REPORTS, ago(h), 3, NOW)?.class)
    ).toEqual([
      'text-green-400',
      'text-lime-300',
      'text-yellow-300',
      'text-orange-400',
      'text-red-400',
    ]);
  });

  it('a queue with reports waiting and no recent action is red; an empty one has no badge', () => {
    const stale = lastActionedBadge(IMAGE_REPORTS, undefined, 4, NOW);
    expect(stale?.class).toBe('text-red-400');
    expect(stale?.at).toBeUndefined();
    expect(lastActionedBadge(IMAGE_REPORTS, undefined, 0, NOW)).toBeNull();
    expect(lastActionedBadge(IMAGE_REPORTS, undefined, null, NOW)).toBeNull();
  });

  it('a recently worked queue keeps its badge after it empties', () => {
    expect(lastActionedBadge(IMAGE_REPORTS, ago(0.1), 0, NOW)?.class).toBe('text-green-400');
  });

  it('a queue the lookup does not cover gets no badge, not a red one', () => {
    // Image › Minor has a count and no last-actioned source; "no time" there means "no data".
    expect(lastActionedBadge('minor', undefined, 500, NOW)).toBeNull();
  });
});

describe('needsAttention', () => {
  const item = (
    label: string,
    countKey: string,
    count: number | null,
    extra = {}
  ): AttentionItem => ({
    section: 'S',
    label,
    path: `/${label}`,
    count,
    countKey,
    ...extra,
  });

  const labels = (r: ReturnType<typeof needsAttention>) =>
    [...r.over, ...r.rest].map((i) => i.label);

  it('ranks by threshold first, then by how long since anyone worked it', () => {
    const rows = needsAttention(
      [
        // `comments` scale: 2 is the worst step.
        item('comment-fresh', 'report:comment', 2),
        item('comment-stale', 'report:commentV2', 2),
        // `reportedImages` scale: 60 is the second-best step.
        item('image', 'report:image', 60),
      ],
      {
        'report:comment': { at: ago(1) },
        'report:commentV2': { at: ago(30) },
        'report:image': { at: ago(200) },
      }
    );
    expect(labels(rows)).toEqual(['comment-stale', 'comment-fresh', 'image']);
    // Over threshold is the worst three steps; the image queue is two steps below that.
    expect(rows.over.map((r) => r.label)).toEqual(['comment-stale', 'comment-fresh']);
  });

  it('a tracked queue nobody touched outranks one worked recently; an untracked one does not', () => {
    const rows = needsAttention(
      [
        item('untracked', 'stuckIngestion', 2), // [200, 50, 10, 1, 0] → step 3
        item('tracked-recent', 'report:post', 3), // posts [20,10,5,3,0] → step 3
        item('tracked-never', 'report:reportedUser', 3), // users, same scale → step 3
      ],
      { 'report:post': { at: ago(1) } }
    );
    expect(labels(rows)).toEqual(['tracked-never', 'tracked-recent', 'untracked']);
  });

  it('ranks nothing as stale before the last-actioned times have loaded', () => {
    const rows = needsAttention(
      // Both step 3. Read as "never worked", the tracked queue would jump the bigger untracked one.
      [item('tracked', 'report:post', 3), item('untracked-bigger', 'stuckIngestion', 5)],
      null
    );
    expect(labels(rows)).toEqual(['untracked-bigger', 'tracked']);
  });

  it('leaves out empty and informational queues', () => {
    const rows = needsAttention(
      [item('empty', 'report:image', 0), item('info', 'articles', 40, { informational: true })],
      null
    );
    expect(labels(rows)).toEqual([]);
  });

  it('keeps a queue that could not be fully counted, so it never reads as clear', () => {
    const rows = needsAttention(
      [
        // Nothing it sums answered, and a tabs group at 0 with one tab unreadable.
        item('unread', 'report:image', null, { partial: true }),
        item('floor', 'modelFlagsNeedsReview', 0, { partial: true }),
        item('empty', 'report:comment', 0),
      ],
      null
    );
    expect(labels(rows).sort()).toEqual(['floor', 'unread']);
  });
});

describe('navWorstRank', () => {
  const counts: Record<string, number> = { 'report:comment': 2, 'report:image': 60, articles: 40 };
  const countFor = (key: string | undefined) => (key ? counts[key] ?? null : null);

  it("gives a group its worst queue's step, ignoring informational children", () => {
    const group = {
      label: 'Reports',
      children: [
        { label: 'Image', countKey: 'report:image' },
        { label: 'Comment', countKey: 'report:comment' },
      ],
    };
    expect(navWorstRank(group, countFor)).toBe(0);

    const quiet = {
      label: 'Articles',
      children: [
        { label: 'Image', countKey: 'report:image' },
        { label: 'Backlog', countKey: 'articles', informational: true },
      ],
    };
    // `articles` at 40 would be red on its own scale; informational, it must not colour the group.
    expect(navWorstRank(quiet, countFor)).toBe(3);
  });
});
