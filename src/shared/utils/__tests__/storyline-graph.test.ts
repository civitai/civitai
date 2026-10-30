import { describe, expect, it } from 'vitest';
import type { StorylineEdge } from '~/shared/utils/storyline-graph';
import { createStorylineLinkJudge, STORYLINE_MAX_PARENTS } from '~/shared/utils/storyline-graph';

// Trunk 1 -> 2 -> 3, then two branches from 3: A (11, 12, 13) and B (21, 22, 23, 24). Chapter 30
// continues A's last chapter.
const edges = (extra: [number, number][] = []): StorylineEdge[] =>
  [
    [2, 1],
    [3, 2],
    [11, 3],
    [12, 11],
    [13, 12],
    [21, 3],
    [22, 21],
    [23, 22],
    [24, 23],
    [30, 13],
    ...extra,
  ].map(([chapterId, parentChapterId]) => ({ chapterId, parentChapterId }));

const judge = (graph: StorylineEdge[], parent: number, chapter: number) =>
  createStorylineLinkJudge(graph, parent)(chapter);

describe('createStorylineLinkJudge', () => {
  it('accepts a rejoin: the end of one branch on to the chapter after the other', () => {
    expect(judge(edges(), 24, 30)).toBeNull();
  });

  it('accepts joining a branch part way along', () => {
    expect(judge(edges(), 24, 12)).toBeNull();
  });

  it('refuses a link that already exists', () => {
    expect(judge(edges([[30, 24]]), 24, 30)).toBe('linked');
  });

  it('refuses a loop: a chapter on to one that comes before it', () => {
    expect(judge(edges(), 30, 11)).toBe('cycle');
    expect(judge(edges(), 30, 3)).toBe('cycle');
    // Control: the same chapter on to one in the other branch is a rejoin, not a loop.
    expect(judge(edges(), 30, 22)).toBeNull();
  });

  it('refuses the new link being a skip: its parent already reaches the chapter', () => {
    expect(judge(edges(), 3, 30)).toBe('shortcut');
    expect(judge(edges(), 11, 13)).toBe('shortcut');
  });

  it("refuses a link that turns an existing edge into a skip, at the chapter's end", () => {
    // 13 -> 30 exists; 13 -> 14 -> 30 would go round it.
    const graph = edges([[14, 13]]);
    expect(judge(graph, 14, 30)).toBe('shortcut');
    // Control: from a branch that does not start at 13, the same link is a rejoin.
    expect(judge(graph, 24, 30)).toBeNull();
  });

  it('refuses a link that turns an existing edge further up into a skip', () => {
    // 3 -> 11 exists; 3 -> 21 ... 24 -> 11 would go round it.
    expect(judge(edges(), 24, 11)).toBe('shortcut');
    // Control: one chapter further along branch A is no longer the fork's own edge.
    expect(judge(edges(), 24, 12)).toBeNull();
  });

  it('refuses a link whose new route would bypass an edge below the chapter', () => {
    // 22 -> 40 exists and 30 -> 40 joins it; 22 -> 30 would put 30 between 22 and 40.
    const graph = edges([
      [40, 22],
      [40, 30],
    ]);
    expect(judge(graph, 22, 30)).toBe('shortcut');
    // Control: without the 30 -> 40 link, 22 -> 30 is a plain rejoin.
    expect(judge(edges([[40, 22]]), 22, 30)).toBeNull();
  });

  it('builds the demo story: two forks, each rejoining, 16 chapters', () => {
    // Trunk 1-3; fork to A (11-13) and B (21-23); both rejoin at R1 (30); R1 forks to C (41, 42)
    // and D (51-53); both rejoin at R2 (60).
    const chain = (ids: number[], from: number): [number, number][] =>
      ids.map((id, i) => [id, i ? ids[i - 1] : from]);
    const graph = [
      ...chain([2, 3], 1),
      ...chain([11, 12, 13], 3),
      ...chain([21, 22, 23], 3),
      [30, 13],
      ...chain([41, 42], 30),
      ...chain([51, 52, 53], 30),
      [60, 42],
    ].map(([chapterId, parentChapterId]) => ({ chapterId, parentChapterId }));
    expect(new Set(graph.flatMap((e) => [e.chapterId, e.parentChapterId])).size).toBe(16);

    expect(judge(graph, 23, 30)).toBeNull();
    graph.push({ chapterId: 30, parentChapterId: 23 });
    expect(judge(graph, 53, 60)).toBeNull();
    graph.push({ chapterId: 60, parentChapterId: 53 });

    // Control: in the finished shape, a real skip is still refused, from either side of a rejoin.
    expect(judge(graph, 30, 60)).toBe('shortcut');
    expect(judge(graph, 3, 30)).toBe('shortcut');
    expect(judge(graph, 60, 21)).toBe('cycle');
  });

  it(`caps a chapter at ${STORYLINE_MAX_PARENTS} parents`, () => {
    // Chapter 30's parents: 13, then leaves 101.. hung off chapter 2, one per extra parent.
    const withParents = (count: number) =>
      edges(
        Array.from({ length: count - 1 }, (_, i): [number, number][] => [
          [101 + i, 2],
          [30, 101 + i],
        ]).flat()
      );
    expect(judge(withParents(STORYLINE_MAX_PARENTS - 1), 24, 30)).toBeNull();
    expect(judge(withParents(STORYLINE_MAX_PARENTS), 24, 30)).toBe('tooManyParents');
  });
});
