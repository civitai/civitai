import { describe, expect, it } from 'vitest';
import type { PlannerPost } from '../../host';
import { moveToDayMoves, previewMoves, shiftDeltaMinutes, shiftMoves } from '../bulk';
import { movedToDayMessage, previewLine, spanLabel } from '../messages';

const now = new Date(2026, 9, 6, 12);
const at = (day: number, hour: number, minute = 5) => new Date(2026, 9, day, hour, minute);
const range = { dailyLimit: 6, minGapMinutes: 30 };

const post = (date: Date, id: number, extra: Partial<PlannerPost> = {}): PlannerPost => ({
  id,
  title: null,
  publishedAt: date.toISOString(),
  modelVersionId: null,
  nsfwLevel: 1,
  imageCount: 1,
  cover: null,
  release: null,
  model: null,
  ...extra,
});

const posts = [
  post(at(7, 9), 1),
  post(at(8, 9), 2),
  post(at(9, 14), 3),
  post(at(9, 9, 20), 4, {
    modelVersionId: 5,
    release: { scope: 'version', modelName: 'M', versionName: 'v1' },
  }),
  post(at(1, 9), 5),
];

describe('shiftDeltaMinutes / shiftMoves', () => {
  it('turns the dialog draft into minutes', () => {
    expect(shiftDeltaMinutes({ amount: 2, unit: 'days' })).toBe(2880);
    expect(shiftDeltaMinutes({ amount: -3, unit: 'hours' })).toBe(-180);
  });

  it('moves the selected scheduled posts and leaves releases and published posts alone', () => {
    const moves = shiftMoves(posts, new Set([1, 2, 4, 5]), 1440, now);
    expect(moves.map((m) => m.post.id)).toEqual([1, 2]);
    expect(moves[0].when).toEqual(at(8, 9));
  });
});

describe('moveToDayMoves', () => {
  it('keeps each post its time of day and skips posts already on that day', () => {
    const moves = moveToDayMoves(posts, new Set([1, 2, 3]), '2026-10-09', now);
    expect(moves.map((m) => m.post.id)).toEqual([1, 2]);
    expect(moves.map((m) => [m.when.getDate(), m.when.getHours()])).toEqual([
      [9, 9],
      [9, 9],
    ]);
  });
});

describe('previewMoves', () => {
  it('reports the spans and no conflicts for a clean shift', () => {
    const preview = previewMoves(
      posts,
      shiftMoves(posts, new Set([1, 2]), 3 * 1440, now),
      range,
      now
    );
    expect(preview.issues).toEqual([]);
    expect(preview.from).toEqual([at(7, 9), at(8, 9)]);
    expect(preview.to).toEqual([at(10, 9), at(11, 9)]);
    expect(previewLine(preview, 'en-US')).toBe('Oct 7–8 → Oct 10–11 · 0 conflicts');
  });

  it('counts the gap and window conflicts the server would refuse', () => {
    const onto = previewMoves(posts, shiftMoves(posts, new Set([2]), 1440, now), range, now);
    expect(onto.issues).toHaveLength(1);
    expect(onto.issues[0]).toMatch(/too close/);
    expect(previewLine(onto, 'en-US')).toBe('Oct 8 → Oct 9 · 1 conflict');

    const back = previewMoves(posts, shiftMoves(posts, new Set([1]), -1440, now), range, now);
    expect(back.issues[0]).toMatch(/10 minutes in the future/);
  });

  it('moves checked together see each other, not only the posts staying put', () => {
    const together = previewMoves(
      posts,
      moveToDayMoves(posts, new Set([1, 2]), '2026-10-12', now),
      range,
      now
    );
    expect(together.issues).toHaveLength(1);
    expect(together.issues[0]).toMatch(/Posts need at least 30 minutes/);
  });

  it('is empty when nothing is selected', () => {
    expect(previewMoves(posts, [], range, now)).toEqual({
      moves: [],
      issues: [],
      from: null,
      to: null,
    });
    expect(previewLine(previewMoves(posts, [], range, now))).toBe('Nothing to move.');
  });
});

describe('spanLabel / movedToDayMessage', () => {
  it('collapses a single day and spells out a month change', () => {
    expect(spanLabel([at(7, 9), at(7, 21)], 'en-US')).toBe('Oct 7');
    expect(spanLabel([at(7, 9), new Date(2026, 10, 2, 9)], 'en-US')).toBe('Oct 7 – Nov 2');
  });

  it('summarises a move-to-day with the first failure', () => {
    expect(movedToDayMessage(3, [], '2026-10-12', 'en-US')).toBe('3 posts moved to Mon, Oct 12.');
    expect(movedToDayMessage(1, ['Too close.', 'Other.'], '2026-10-12', 'en-US')).toBe(
      '1 post moved to Mon, Oct 12. 2 posts not moved: Too close.'
    );
  });
});
