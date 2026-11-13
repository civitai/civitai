export type StorylineEdge = { chapterId: number; parentChapterId: number };

/** Keeps a rejoin's markers and the choosers that offer it readable. */
export const STORYLINE_MAX_PARENTS = 8;

export type StorylineLinkRefusal = 'linked' | 'tooManyParents' | 'cycle' | 'shortcut';

export const STORYLINE_LINK_REFUSALS: Record<StorylineLinkRefusal, string> = {
  linked: 'That chapter already continues from this one',
  tooManyParents: `A chapter can be joined from at most ${STORYLINE_MAX_PARENTS} chapters`,
  cycle: 'That chapter comes before this one, so the story would loop',
  shortcut: 'That link would skip chapters on a route through the story',
};

function reachable(start: number, next: ReadonlyMap<number, number[]>) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const n of next.get(queue.pop() as number) ?? [])
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
  }
  return seen;
}

/**
 * Judges linking chapters of one storyline as a way on from `parentChapterId`, given its edges.
 * Besides a loop, it refuses any link after which some edge u -> v has a longer route from u to v
 * as well: a skip, whichever of the two is the new edge, so chapter numbers along a route never
 * jump. A rejoin of two branches has no such edge.
 */
export function createStorylineLinkJudge(edges: StorylineEdge[], parentChapterId: number) {
  const parentsOf = new Map<number, number[]>();
  const childrenOf = new Map<number, number[]>();
  for (const { chapterId, parentChapterId: parentId } of edges) {
    parentsOf.set(chapterId, [...(parentsOf.get(chapterId) ?? []), parentId]);
    childrenOf.set(parentId, [...(childrenOf.get(parentId) ?? []), chapterId]);
  }
  const upFromParent = reachable(parentChapterId, parentsOf);

  return (chapterId: number): StorylineLinkRefusal | null => {
    const parents = parentsOf.get(chapterId) ?? [];
    if (parents.includes(parentChapterId)) return 'linked';
    if (parents.length >= STORYLINE_MAX_PARENTS) return 'tooManyParents';
    if (upFromParent.has(chapterId)) return 'cycle';
    if (reachable(chapterId, parentsOf).has(parentChapterId)) return 'shortcut';
    const downFromChapter = reachable(chapterId, childrenOf);
    for (const u of upFromParent)
      for (const v of childrenOf.get(u) ?? []) if (downFromChapter.has(v)) return 'shortcut';
    return null;
  };
}
