/** A judge's vote as stored in their outcomes set: `"{winnerEntryId}>{loserEntryId}"`. */
export function createVoteOutcome(winnerEntryId: number, loserEntryId: number) {
  return `${winnerEntryId}>${loserEntryId}`;
}

/** Canonical pair key, sorted so a:b == b:a. */
export function createPairKey(entryId1: number, entryId2: number): string {
  return entryId1 < entryId2 ? `${entryId1}:${entryId2}` : `${entryId2}:${entryId1}`;
}

/**
 * Pair keys (`small:large`) this judge's own votes already decide by transitivity: A>B and B>C
 * decide A-C, so serving A-C asks a question they have answered. Only their own votes count, never
 * other judges'. Pairs they voted on directly stay unservable through the voted-pairs set.
 *
 * A pair their votes reach both ways (a cycle, A>B, B>C, C>A, makes A-C both A>C and C>A) is not
 * decided and stays servable: the judge contradicted themself, so asking again is how it resolves.
 *
 * O(V·E) over this judge's votes, and the result can grow with the square of the entries they
 * judged, so `decidedPairKeys` only runs it up to `MAX_CLOSURE_VOTES`.
 */
export function impliedPairKeys(outcomes: string[]): Set<string> {
  const beats = new Map<number, number[]>();
  for (const outcome of outcomes) {
    const [winner, loser] = outcome.split('>').map(Number);
    if (!Number.isInteger(winner) || !Number.isInteger(loser) || winner === loser) continue;
    const list = beats.get(winner);
    if (list) list.push(loser);
    else beats.set(winner, [loser]);
  }

  const reaches = new Map<number, Set<number>>();
  for (const start of beats.keys()) {
    const seen = new Set<number>();
    const stack = [...(beats.get(start) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const after of beats.get(next) ?? []) if (!seen.has(after)) stack.push(after);
    }
    reaches.set(start, seen);
  }

  const implied = new Set<string>();
  for (const [start, seen] of reaches) {
    for (const end of seen) {
      if (end === start || reaches.get(end)?.has(start)) continue;
      implied.add(createPairKey(start, end));
    }
  }
  return implied;
}

/**
 * Recomputed on every serve and status read, so it is capped: past this many votes in one crucible
 * the judge is served as before the skip (directly voted pairs only). The skip is for small
 * crucibles, where a judge reaches the end.
 * shortcut: a judge past the cap loses the skip; cache the closure per judge if big crucibles need it.
 */
export const MAX_CLOSURE_VOTES = 200;

/** Pairs this judge is not served again: voted directly, or decided by their votes. */
export function decidedPairKeys(votedPairKeys: string[], outcomes: string[]): string[] {
  if (!outcomes.length || outcomes.length > MAX_CLOSURE_VOTES) return votedPairKeys;
  const decided = impliedPairKeys(outcomes);
  for (const key of votedPairKeys) decided.add(key);
  return [...decided];
}
