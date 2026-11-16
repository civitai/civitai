import { describe, expect, test } from 'vitest';
import {
  activeTimedComment,
  clusterTimedComments,
  TIMED_COMMENT_LABEL_SEC,
} from '~/components/Music/TimedComments/timed-comments';

const c = (id: number, timestampSec: number) => ({ id, timestampSec });
const ids = (clusters: { comments: { id: number }[] }[]) =>
  clusters.map((cluster) => cluster.comments.map((comment) => comment.id));

describe('clusterTimedComments', () => {
  // 200 s across 400 px: 2 px a second, so 24 px avatars overlap under 12 s apart.
  const at = (comments: { id: number; timestampSec: number }[]) =>
    clusterTimedComments(comments, 200, 400, 24);

  test('merges comments whose avatars would overlap, and keeps the rest apart', () => {
    expect(ids(at([c(1, 10), c(2, 15), c(3, 21), c(4, 60), c(5, 120)]))).toEqual([
      [1, 2, 3],
      [4],
      [5],
    ]);
  });

  test('a cluster sits at its first comment’s time', () => {
    expect(at([c(1, 50), c(2, 52), c(3, 150)]).map((cluster) => cluster.timestampSec)).toEqual([
      50, 150,
    ]);
  });

  test('a wider waveform pulls a cluster apart', () => {
    const comments = [c(1, 50), c(2, 55)];
    expect(ids(clusterTimedComments(comments, 200, 400, 24))).toEqual([[1, 2]]);
    expect(ids(clusterTimedComments(comments, 200, 1600, 24))).toEqual([[1], [2]]);
  });

  test('chains: a comment joins when it overlaps the one before, not the cluster’s first', () => {
    expect(ids(at([c(1, 10), c(2, 20), c(3, 30)]))).toEqual([[1, 2, 3]]);
  });

  test('avatars exactly one avatar apart do not overlap', () => {
    expect(ids(at([c(1, 10), c(2, 22)]))).toEqual([[1], [2]]);
  });

  test('without a width or a length every comment stands alone', () => {
    expect(ids(clusterTimedComments([c(1, 50), c(2, 51)], 200, 0, 24))).toEqual([[1], [2]]);
    expect(ids(clusterTimedComments([c(1, 50), c(2, 51)], 0, 400, 24))).toEqual([[1], [2]]);
  });
});

describe('activeTimedComment', () => {
  const L = TIMED_COMMENT_LABEL_SEC;
  const clusters = clusterTimedComments([c(1, 50), c(2, 51), c(3, 52), c(4, 150)], 200, 400, 24);

  test('a reached cluster shows its comments one after another, each for the label time', () => {
    expect(activeTimedComment(clusters, 49)).toBeUndefined();
    expect(activeTimedComment(clusters, 50)?.id).toBe(1);
    expect(activeTimedComment(clusters, 50 + L - 0.1)?.id).toBe(1);
    expect(activeTimedComment(clusters, 50 + L)?.id).toBe(2);
    expect(activeTimedComment(clusters, 50 + 2 * L)?.id).toBe(3);
    expect(activeTimedComment(clusters, 50 + 3 * L)).toBeUndefined();
  });

  test('across clusters the latest one reached wins, even while a chain is still running', () => {
    // 50–54 run their labels 50, 54, 58, 62 and 66–70; 67 starts the next cluster inside that.
    const chained = clusterTimedComments(
      [c(1, 50), c(2, 51), c(3, 52), c(4, 53), c(5, 54), c(6, 67)],
      200,
      400,
      24
    );
    expect(ids(chained)).toEqual([[1, 2, 3, 4, 5], [6]]);
    expect(activeTimedComment(chained, 66.5)?.id).toBe(5);
    expect(activeTimedComment(chained, 68)?.id).toBe(6);
  });

  test('a lone comment shows from its time for the label time', () => {
    expect(activeTimedComment(clusters, 150)?.id).toBe(4);
    expect(activeTimedComment(clusters, 150 + L)).toBeUndefined();
  });
});
