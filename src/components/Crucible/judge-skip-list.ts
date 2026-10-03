/** About ten pairs. The server brings skipped entries back once nothing else is left to judge. */
export const JUDGE_SKIP_LIST_LIMIT = 20;

type PairIds = { left: { id: number }; right: { id: number } };

export type JudgeSkipListAction = { type: 'skip'; pair: PairIds } | { type: 'vote'; pair: PairIds };

export function judgeSkipListReducer(skipped: number[], { type, pair }: JudgeSkipListAction) {
  const rest = skipped.filter((id) => id !== pair.left.id && id !== pair.right.id);
  // A vote must not clear the list: pairing is near-deterministic, so the pair just skipped is
  // the next one served. Voting on an entry only takes that entry off it.
  if (type === 'vote') return rest.length === skipped.length ? skipped : rest;
  return [...rest, pair.left.id, pair.right.id].slice(-JUDGE_SKIP_LIST_LIMIT);
}
