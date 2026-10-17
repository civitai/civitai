import { describe, expect, it } from 'vitest';
import type { StorylineLaneEdge, StorylineLanes } from '~/shared/utils/storyline-lanes';
import {
  layoutStorylineLanes,
  storylineLanePath,
  storylineLaneRoute,
} from '~/shared/utils/storyline-lanes';

/** `[chapter, parent]` pairs, oldest first; `*` after a pair's chapter marks the edge canon. */
const graph = (pairs: [number | `${number}*`, number][]): StorylineLaneEdge[] =>
  pairs.map(([chapter, parentChapterId]) => ({
    chapterId: Number(String(chapter).replace('*', '')),
    parentChapterId,
    canon: String(chapter).endsWith('*'),
  }));

const layout = (pairs: [number | `${number}*`, number][], chapterIds?: number[]) => {
  const edges = graph(pairs);
  const ids = chapterIds ?? [1, ...new Set(edges.map((e) => e.chapterId).filter((id) => id !== 1))];
  return layoutStorylineLanes(1, ids, edges);
};

const placed = (lanes: StorylineLanes) =>
  Object.fromEntries(lanes.nodes.map((n) => [n.chapterId, [n.row, n.lane]]));

const link = (lanes: StorylineLanes, parentChapterId: number, chapterId: number) =>
  lanes.links.find((l) => l.parentChapterId === parentChapterId && l.chapterId === chapterId);

// The demo story: trunk 1-3; fork to A (11-13, canon) and B (21-23); both rejoin at R1 (30);
// R1 forks to C (41, 42, canon) and D (51-53); both rejoin at R2 (60). 16 chapters.
const demo: [number | `${number}*`, number][] = [
  ['2*', 1],
  ['3*', 2],
  ['11*', 3],
  [21, 3],
  ['12*', 11],
  ['22*', 21],
  ['13*', 12],
  ['23*', 22],
  ['30*', 13],
  ['30*', 23],
  ['41*', 30],
  [51, 30],
  ['42*', 41],
  ['52*', 51],
  ['53*', 52],
  ['60*', 42],
  ['60*', 53],
];

describe('layoutStorylineLanes', () => {
  it('lays out the demo story as two lanes that fork and rejoin twice', () => {
    const lanes = layout(demo);
    expect(lanes.nodes).toHaveLength(16);
    expect(placed(lanes)).toEqual({
      1: [0, 0],
      2: [1, 0],
      3: [2, 0],
      11: [3, 0],
      21: [3, 1],
      12: [4, 0],
      22: [4, 1],
      13: [5, 0],
      23: [5, 1],
      30: [6, 0],
      41: [7, 0],
      51: [7, 1],
      42: [8, 0],
      52: [8, 1],
      53: [9, 1],
      60: [10, 0],
    });
    expect(lanes).toMatchObject({ rows: 11, lanes: 2 });
  });

  it('puts a rejoin below the longer branch, the shorter one running down its lane to it', () => {
    const lanes = layout(demo);
    expect(link(lanes, 42, 60)).toMatchObject({ from: { row: 8 }, to: { row: 10 }, runLane: 0 });
    // Control: branches of equal length meet with no run.
    expect(link(lanes, 13, 30)).toMatchObject({ runLane: null });
    expect(link(lanes, 23, 30)).toMatchObject({ runLane: null });
  });

  it('colours a fork by the lane it opens and a rejoin by the lane it arrives from', () => {
    const lanes = layout(demo);
    expect(link(lanes, 3, 21)?.lane).toBe(1);
    expect(link(lanes, 23, 30)?.lane).toBe(1);
    expect(link(lanes, 53, 60)?.lane).toBe(1);
    expect(link(lanes, 12, 13)?.lane).toBe(0);
  });

  it('carries a lane on through the canon child, not the oldest one', () => {
    // 3 is older but 4 is canon.
    const lanes = layout([
      ['2*', 1],
      [3, 2],
      ['4*', 2],
    ]);
    expect(placed(lanes)).toMatchObject({ 3: [2, 1], 4: [2, 0] });
    // Control: with no canon child, the oldest carries the lane on.
    expect(
      placed(
        layout([
          ['2*', 1],
          [3, 2],
          [4, 2],
        ])
      )
    ).toMatchObject({ 3: [2, 0], 4: [2, 1] });
  });

  it('gives a rejoin the lowest lane its branches arrive in, freeing the other', () => {
    // 2 forks three ways: 3 carries lane 0 on, 4 and 5 open lanes 1 and 2 and rejoin at 6,
    // which takes lane 1. Lane 2 is then free for the fork at 7.
    const lanes = layout([
      ['2*', 1],
      ['3*', 2],
      [4, 2],
      [5, 2],
      ['6*', 4],
      ['6*', 5],
      ['7*', 3],
      ['8*', 7],
      [9, 7],
      ['10*', 6],
    ]);
    expect(placed(lanes)).toMatchObject({
      3: [2, 0],
      4: [2, 1],
      5: [2, 2],
      6: [3, 1],
      7: [3, 0],
      8: [4, 0],
      9: [4, 2],
      10: [4, 1],
    });
  });

  it('frees a lane when its branch ends', () => {
    // 3 opens lane 1 and ends; the later fork from 5 reuses lane 1.
    const lanes = layout([
      ['2*', 1],
      [3, 2],
      ['4*', 2],
      ['5*', 4],
      ['6*', 5],
      [7, 5],
    ]);
    expect(placed(lanes)).toMatchObject({ 3: [2, 1], 7: [4, 1] });
    expect(lanes.lanes).toBe(2);
    // Control: while branch 3 still runs at that row, the fork opens lane 2.
    const longer = layout([
      ['2*', 1],
      [3, 2],
      ['31*', 3],
      ['32*', 31],
      ['4*', 2],
      ['5*', 4],
      ['6*', 5],
      [7, 5],
    ]);
    expect(placed(longer)).toMatchObject({ 3: [2, 1], 32: [4, 1], 7: [4, 2] });
  });

  it("runs a link that is not a chapter's way on down a lane of its own", () => {
    // 3 carries on to 4 in lane 0 and also links to 9, the end of a longer branch's rejoin.
    const lanes = layout([
      ['2*', 1],
      ['3*', 2],
      [5, 2],
      ['4*', 3],
      ['6*', 5],
      ['7*', 6],
      ['9*', 7],
      [9, 3],
    ]);
    expect(placed(lanes)).toMatchObject({ 3: [2, 0], 4: [3, 0], 5: [2, 1], 9: [5, 1] });
    expect(link(lanes, 3, 9)).toMatchObject({ runLane: 2, lane: 2 });
    expect(lanes.lanes).toBe(3);
  });

  it('leaves out chapters it cannot reach and links outside the chapters given', () => {
    // A capped read without 13 and 23: R1 (30) has no parent given, and 99 links to nothing.
    const ids = [1, 2, 3, 11, 12, 21, 22, 30, 99];
    const lanes = layout(demo, ids);
    expect(lanes.nodes.map((n) => n.chapterId).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 11, 12, 21, 22,
    ]);
    expect(lanes.links.every((l) => ids.includes(l.chapterId))).toBe(true);
    expect(lanes.links).toHaveLength(6);
  });

  it('returns nothing without chapter 1', () => {
    expect(layoutStorylineLanes(1, [2, 3], graph([['3*', 2]]))).toEqual({
      nodes: [],
      links: [],
      rows: 0,
      lanes: 0,
    });
  });
});

describe('storylineLaneRoute', () => {
  const lanes = layout(demo);

  it('follows the line that arrives in the chapter’s own lane', () => {
    expect(storylineLaneRoute(lanes, 60)).toEqual([1, 2, 3, 11, 12, 13, 30, 41, 42, 60]);
    expect(storylineLaneRoute(lanes, 53)).toEqual([1, 2, 3, 11, 12, 13, 30, 51, 52, 53]);
    expect(storylineLaneRoute(lanes, 22)).toEqual([1, 2, 3, 21, 22]);
  });

  it("prefers the chapter's own lane over its oldest link", () => {
    // B's link into R1 is the older one, but R1 sits in A's lane.
    const bFirst = layout([
      ...demo.slice(0, 8),
      ['30*', 23],
      ...demo.slice(8).filter(([c, p]) => !(c === '30*' && p === 23)),
    ]);
    expect(bFirst.links.filter((l) => l.chapterId === 30)[0].parentChapterId).toBe(23);
    expect(placed(bFirst)[30]).toEqual([6, 0]);
    expect(storylineLaneRoute(bFirst, 30)).toEqual([1, 2, 3, 11, 12, 13, 30]);
  });

  it('takes the oldest link when no line arrives in the lane', () => {
    // 3 and 4 each carry their lane on (to 5 and 6), so 7, joined from both, opens lane 2.
    const pairs = (links: [number, number][]): [number | `${number}*`, number][] => [
      ['2*', 1],
      ['3*', 2],
      [4, 2],
      ['5*', 3],
      ['6*', 4],
      ...links,
    ];
    const fromThree = layout(
      pairs([
        [7, 3],
        [7, 4],
      ])
    );
    expect(placed(fromThree)[7]).toEqual([3, 2]);
    expect(storylineLaneRoute(fromThree, 7)).toEqual([1, 2, 3, 7]);
    // Control: with the link from 4 the older one, the route comes through 4.
    expect(
      storylineLaneRoute(
        layout(
          pairs([
            [7, 4],
            [7, 3],
          ])
        ),
        7
      )
    ).toEqual([1, 2, 4, 7]);
  });

  it('is empty for a chapter not on the map', () => {
    expect(storylineLaneRoute(lanes, 999)).toEqual([]);
  });
});

describe('storylineLanePath', () => {
  const at = ({ lane, row }: { lane: number; row: number }) => ({ x: lane * 10, y: row * 100 });

  it('draws a link within a lane as a straight line', () => {
    expect(
      storylineLanePath({ from: { row: 1, lane: 0 }, to: { row: 2, lane: 0 }, runLane: null }, at)
    ).toBe('M 0 100 L 0 200');
  });

  it('curves a fork across lanes over the one row gap', () => {
    expect(
      storylineLanePath({ from: { row: 2, lane: 0 }, to: { row: 3, lane: 1 }, runLane: null }, at)
    ).toBe('M 0 200 C 0 250 10 250 10 300');
  });

  it('runs a long rejoin down its lane, then curves into the chapter', () => {
    expect(
      storylineLanePath({ from: { row: 8, lane: 1 }, to: { row: 10, lane: 0 }, runLane: 1 }, at)
    ).toBe('M 10 800 L 10 900 C 10 950 0 950 0 1000');
  });

  it('curves out to a run in another lane first, then down, then in', () => {
    expect(
      storylineLanePath({ from: { row: 2, lane: 0 }, to: { row: 5, lane: 1 }, runLane: 2 }, at)
    ).toBe('M 0 200 C 0 250 20 250 20 300 L 20 400 C 20 450 10 450 10 500');
  });
});
