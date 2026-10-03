import { describe, expect, it } from 'vitest';
import { JUDGE_SKIP_LIST_LIMIT, judgeSkipListReducer } from '~/components/Crucible/judge-skip-list';
import { getJudgingPairSchema } from '~/server/schema/crucible.schema';

const pair = (left: number, right: number) => ({ left: { id: left }, right: { id: right } });

describe('judgeSkipListReducer', () => {
  it('adds both entries of a skipped pair', () => {
    expect(judgeSkipListReducer([1, 2], { type: 'skip', pair: pair(3, 4) })).toEqual([1, 2, 3, 4]);
  });

  it('keeps only the most recent entries', () => {
    const full = Array.from({ length: JUDGE_SKIP_LIST_LIMIT }, (_, i) => i + 1);
    const next = judgeSkipListReducer(full, { type: 'skip', pair: pair(100, 101) });

    expect(next).toHaveLength(JUDGE_SKIP_LIST_LIMIT);
    expect(next.slice(-2)).toEqual([100, 101]);
    expect(next).not.toContain(1);
  });

  it('never grows past what getJudgingPair accepts, or every pair request is rejected', () => {
    let skipped: number[] = [];
    for (let id = 1; id < 200; id += 2) {
      skipped = judgeSkipListReducer(skipped, { type: 'skip', pair: pair(id, id + 1) });
    }

    expect(
      getJudgingPairSchema.safeParse({ crucibleId: 1, excludeEntryIds: skipped }).success
    ).toBe(true);
  });

  it('does not list an entry twice when a pair holding it is skipped again', () => {
    expect(judgeSkipListReducer([1, 2], { type: 'skip', pair: pair(2, 3) })).toEqual([1, 2, 3]);
  });

  // The fix for skipped pairs coming straight back: do not turn a vote into a reset.
  it('keeps the skip list across a vote on other entries, as the same array', () => {
    const skipped = [1, 2];
    expect(judgeSkipListReducer(skipped, { type: 'vote', pair: pair(3, 4) })).toBe(skipped);
  });

  it('takes an entry off the list once the judge votes on it', () => {
    expect(judgeSkipListReducer([1, 2, 5], { type: 'vote', pair: pair(2, 9) })).toEqual([1, 5]);
  });
});
