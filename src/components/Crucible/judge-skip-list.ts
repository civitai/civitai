import { useCallback, useState } from 'react';

/** The server brings skipped entries back once nothing else is left to judge. */
export const JUDGE_SKIP_LIST_LIMIT = 10;

type PairIds = { left: { id: number }; right: { id: number } };
/** Lower id first, so a pair skipped again in the other order is the same entry. */
export type SkippedPair = [number, number];

export type JudgeSkipListAction = { type: 'skip'; pair: PairIds } | { type: 'vote'; pair: PairIds };

const toSkippedPair = ({ left, right }: PairIds): SkippedPair =>
  left.id < right.id ? [left.id, right.id] : [right.id, left.id];

export function judgeSkipListReducer(skipped: SkippedPair[], { type, pair }: JudgeSkipListAction) {
  const [a, b] = toSkippedPair(pair);
  if (type === 'vote') {
    // A vote must not clear the list: pairing is near-deterministic, so the pair just skipped is
    // the next one served. Voting on an entry only takes the pairs holding it off it.
    const rest = skipped.filter((p) => !p.includes(a) && !p.includes(b));
    return rest.length === skipped.length ? skipped : rest;
  }
  const rest = skipped.filter(([x, y]) => x !== a || y !== b);
  return [...rest, [a, b] as SkippedPair].slice(-JUDGE_SKIP_LIST_LIMIT);
}

export function useJudgeSkipList() {
  const [skippedPairs, setSkippedPairs] = useState<SkippedPair[]>([]);

  const skip = useCallback(
    (pair: PairIds) =>
      setSkippedPairs((prev) => judgeSkipListReducer(prev, { type: 'skip', pair })),
    []
  );

  /** True when the list changed, which moves the pair query's input so it fetches on its own. */
  const recordVote = useCallback(
    (pair: PairIds) => {
      const next = judgeSkipListReducer(skippedPairs, { type: 'vote', pair });
      if (next === skippedPairs) return false;
      setSkippedPairs(next);
      return true;
    },
    [skippedPairs]
  );

  return { skippedPairs, skip, recordVote };
}
