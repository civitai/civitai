// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import {
  JUDGE_SKIP_LIST_LIMIT,
  judgeSkipListReducer,
  useJudgeSkipList,
} from '~/components/Crucible/judge-skip-list';
import { getJudgingPairSchema } from '~/server/schema/crucible.schema';

const pair = (left: number, right: number) => ({ left: { id: left }, right: { id: right } });

function renderSkipList() {
  const result = { current: undefined as unknown as ReturnType<typeof useJudgeSkipList> };
  function Probe() {
    result.current = useJudgeSkipList();
    return null;
  }
  act(() => createRoot(document.createElement('div')).render(createElement(Probe)));
  return result;
}

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

  // Identity, not equality: the page reads "same array" as "the pair query's input did not move, so
  // refetch by hand". A copy with the same ids leaves the judge on the pair they just voted on.
  it('returns the SAME array after a vote on other entries, which tells the page to refetch', () => {
    const skipped = [1, 2];
    expect(judgeSkipListReducer(skipped, { type: 'vote', pair: pair(3, 4) })).toBe(skipped);
  });

  it('takes an entry off the list once the judge votes on it', () => {
    expect(judgeSkipListReducer([1, 2, 5], { type: 'vote', pair: pair(2, 9) })).toEqual([1, 5]);
  });
});

describe('useJudgeSkipList', () => {
  // The reported bug: the page cleared its skips on every vote, and the skipped pair came straight
  // back. The page holds no skip state of its own, so this is the code a vote runs.
  it('keeps the skips across a vote on other entries, and asks for a manual refetch', () => {
    const list = renderSkipList();
    act(() => list.current.skip(pair(1, 2)));

    let changed = true;
    act(() => {
      changed = list.current.recordVote(pair(3, 4));
    });

    expect(changed).toBe(false);
    expect(list.current.skippedEntryIds).toEqual([1, 2]);
  });

  it('drops a voted entry and reports the change, so the moved input fetches the next pair', () => {
    const list = renderSkipList();
    act(() => list.current.skip(pair(1, 2)));

    let changed = false;
    act(() => {
      changed = list.current.recordVote(pair(2, 7));
    });

    expect(changed).toBe(true);
    expect(list.current.skippedEntryIds).toEqual([1]);
  });
});
