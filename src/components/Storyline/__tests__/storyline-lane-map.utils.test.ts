import { describe, expect, it } from 'vitest';
import {
  buildCanonLane,
  buildStorylineLaneMap,
  buildStorylineLaneList,
  getStorylinePathLanes,
  laneColor,
  LANE_COLORS,
  storylineMayBranch,
} from '~/components/Storyline/storyline-lane-map.utils';
import { parseIdListParam, STORYLINE_VIA_PARAM } from '~/components/Storyline/storyline-mode.utils';
import type { StorylinePathChapter } from '~/server/services/storyline.service';

// The demo story: trunk 1-3; A (11-13, canon) and B (21-23) rejoin at R1 (30); C (41, 42, canon)
// and D (51-53) rejoin at R2 (60). Every chapter untitled, so the map names it by its number.
const pairs: [number, number, boolean][] = [
  [2, 1, true],
  [3, 2, true],
  [11, 3, true],
  [21, 3, false],
  [12, 11, true],
  [22, 21, true],
  [13, 12, true],
  [23, 22, true],
  [30, 13, true],
  [30, 23, true],
  [41, 30, true],
  [51, 30, false],
  [42, 41, true],
  [52, 51, true],
  [53, 52, true],
  [60, 42, true],
  [60, 53, true],
];
const ids = [1, ...new Set(pairs.map(([c]) => c))];
const edges = pairs.map(([chapterId, parentChapterId, canon]) => ({
  chapterId,
  parentChapterId,
  canon,
}));

const visible = (chapterId: number) => ({
  chapterId,
  depth: 0,
  tombstone: null,
  post: { id: chapterId * 10, title: null, userId: 1, username: 'author' },
  firstImage: { id: chapterId * 100 },
});

const build = (
  chapter: (id: number) => StorylinePathChapter & { firstImage: { id: number } | null }
) =>
  buildStorylineLaneMap({ rootChapterId: 1, chapters: ids.map(chapter), edges, truncated: false });

const node = (map: ReturnType<typeof build>, chapterId: number) =>
  map?.nodes.find((n) => n.chapterId === chapterId);

const viaOf = (href: string | null | undefined) =>
  parseIdListParam(
    new URL(href ?? '', 'https://civitai.com').searchParams.get(STORYLINE_VIA_PARAM)
  );

describe('buildStorylineLaneMap', () => {
  const map = build(visible);

  it('numbers an untitled chapter by the route its link opens, as the reader will', () => {
    // R2 sits on row 10, below the longer branch D, but its link opens it through C: 10 chapters.
    expect(node(map, 60)).toMatchObject({ row: 10, name: 'Chapter 10 by author' });
    expect(viaOf(node(map, 60)?.href)).toEqual([13, 42]);
    // Through D the same row count is the route's own length.
    expect(node(map, 53)).toMatchObject({ row: 9, name: 'Chapter 10 by author' });
    expect(viaOf(node(map, 53)?.href)).toEqual([13]);
    expect(node(map, 22)).toMatchObject({ name: 'Chapter 5 by author' });
    expect(viaOf(node(map, 22)?.href)).toEqual([]);
  });

  it('opens the same route on a plain click as its href does', () => {
    expect(node(map, 60)?.read).toEqual({ imageId: 6000, chapterId: 60, via: [13, 42] });
    expect(node(map, 53)?.read).toEqual({ imageId: 5300, chapterId: 53, via: [13] });
  });

  it('links a chapter the reader cannot see nowhere, even with an image left on it', () => {
    // As a chapter whose author the reader just hid reaches the map: no post, image still there.
    const hidden = build((id) =>
      id === 22
        ? {
            chapterId: 22,
            depth: 0,
            tombstone: 'unavailable',
            post: null,
            firstImage: { id: 2200 },
          }
        : visible(id)
    );
    expect(node(hidden, 22)).toMatchObject({
      href: null,
      read: null,
      name: 'This chapter is not available',
    });
    // Control: a chapter with a post but no image this reader may see opens its post.
    const noImage = build((id) => (id === 22 ? { ...visible(22), firstImage: null } : visible(id)));
    expect(node(noImage, 22)).toMatchObject({ href: '/posts/220', read: null });
    expect(node(map, 22)?.href).toBe('/images/2200?storylineChapter=22');
  });

  it('carries a capped read through, for the note under the map', () => {
    const capped = buildStorylineLaneMap({
      rootChapterId: 1,
      chapters: ids.map(visible),
      edges,
      truncated: true,
    });
    expect(capped?.truncated).toBe(true);
    expect(map?.truncated).toBe(false);
  });

  it('is null without chapter 1', () => {
    expect(
      buildStorylineLaneMap({ rootChapterId: null, chapters: [], edges: [], truncated: false })
    ).toBeNull();
  });
});

describe('storylineMayBranch', () => {
  const path = (forkAt?: number) =>
    Array.from({ length: 3 }, (_, i) => ({ childCount: i === forkAt ? 2 : 1 }));

  it('reads the map when the canon path forks', () => {
    expect(storylineMayBranch({ chapterCount: 4, mainPath: path(1) })).toBe(true);
  });

  it('reads it when the canon path stops short of a fork further on', () => {
    // Chapter 3 has no canon child; the story forks below it, off the canon path.
    expect(storylineMayBranch({ chapterCount: 6, mainPath: path() })).toBe(true);
  });

  it('skips it when every chapter is on the canon path', () => {
    expect(storylineMayBranch({ chapterCount: 3, mainPath: path() })).toBe(false);
  });
});

describe('buildStorylineLaneList', () => {
  // The demo story, with B's chapters by a second author so the join can name them.
  const map = build((id) =>
    [21, 22, 23].includes(id)
      ? { ...visible(id), post: { ...visible(id).post, username: 'civchan' } }
      : visible(id)
  )!;
  const canonOf = (m: typeof map, ids: number[]) =>
    ids.map((id) => m.nodes.find((n) => n.chapterId === id)!);
  const list = buildStorylineLaneList(map, canonOf(map, [1, 2, 3, 11, 12, 13, 30, 41, 42, 60]));
  const shape = (rows: typeof list.rows) =>
    rows.map((r) => ({
      ids: [r.canon?.chapterId ?? null, ...r.branches.map((n) => n.chapterId)],
      bands: r.bands.map((b) =>
        b.kind === 'fork' ? `fork@${b.chapterId}` : `join@${b.chapterId}`
      ),
    }));

  it('puts the canon path down the canon column and the other paths beside it, row by row', () => {
    expect(shape(list.rows).map((r) => r.ids)).toEqual([
      [1],
      [2],
      [3],
      [11, 21],
      [12, 22],
      [13, 23],
      [30],
      [41, 51],
      [42, 52],
      [null, 53],
      [60],
    ]);
  });

  it('marks each fork before the row its ways on start in, and each join before its chapter', () => {
    expect(shape(list.rows).map((r) => r.bands)).toEqual([
      [],
      [],
      [],
      ['fork@3'],
      [],
      [],
      ['join@30'],
      ['fork@30'],
      [],
      [],
      ['join@60'],
    ]);
    expect(list.rows[3].bands[0]).toMatchObject({ kind: 'fork', number: 3, paths: 2, canon: true });
  });

  it('names who wrote the path that joins, not the one it joins', () => {
    expect(list.rows[6].bands[0]).toMatchObject({
      kind: 'rejoin',
      joining: 1,
      authors: ['civchan'],
    });
    expect(list.rows[10].bands[0]).toMatchObject({
      kind: 'rejoin',
      joining: 1,
      authors: ['author'],
    });
  });

  it('shows each way on from a canon fork its share at that fork', () => {
    expect(Object.fromEntries(list.canonForkOf)).toEqual({ 11: 3, 21: 3, 41: 30, 51: 30 });
  });

  // The layout hands lane 0 on once the canon path ends: here canon 2 is a leaf, and the branch
  // chapter 5 (a way on from branch chapter 3) is laid out in lane 0 below it.
  const offCanon = buildStorylineLaneMap({
    rootChapterId: 1,
    chapters: [1, 2, 3, 4, 5].map(visible),
    edges: [
      { chapterId: 2, parentChapterId: 1, canon: true },
      { chapterId: 3, parentChapterId: 1, canon: false },
      { chapterId: 4, parentChapterId: 3, canon: true },
      { chapterId: 5, parentChapterId: 3, canon: false },
    ],
    truncated: false,
  })!;

  it('never puts a branch chapter in the canon column, even in lane 0 of the layout', () => {
    expect(offCanon.nodes.find((n) => n.chapterId === 5)?.lane).toBe(0);
    const { rows, lanes } = buildStorylineLaneList(offCanon, canonOf(offCanon, [1, 2]));
    expect(rows.map((r) => r.canon?.chapterId ?? null)).toEqual([1, 2, null]);
    expect(rows[2].branches.map((n) => [n.chapterId, n.lane])).toEqual([
      [4, 1],
      [5, 2],
    ]);
    expect(lanes).toBe(3);
  });

  it('says whose path forks when the fork is off the canon path, not a canon chapter number', () => {
    const { rows, canonForkOf } = buildStorylineLaneList(offCanon, canonOf(offCanon, [1, 2]));
    // Shares load only at canon forks.
    expect(Object.fromEntries(canonForkOf)).toEqual({ 2: 1, 3: 1 });
    expect(rows[2].bands).toEqual([
      expect.objectContaining({ kind: 'fork', chapterId: 3, canon: false, author: 'author' }),
    ]);
  });

  it('lists the whole canon path, in order, when a capped graph cut some of it', () => {
    const capped = buildStorylineLaneMap({
      rootChapterId: 1,
      chapters: [1, 2, 9].map(visible),
      edges: [
        { chapterId: 2, parentChapterId: 1, canon: true },
        { chapterId: 9, parentChapterId: 1, canon: false },
      ],
      truncated: true,
    })!;
    const canon = buildCanonLane([1, 2, 3, 4].map((id, depth) => ({ ...visible(id), depth })));
    const { rows, lanes } = buildStorylineLaneList(capped as never, canon);
    expect(rows.map((r) => r.canon?.chapterId)).toEqual([1, 2, 3, 4]);
    expect(lanes).toBe(1);
  });

  it('names the branch that joins a chapter moved off lane 0, not the canon end it follows', () => {
    // Canon ends at 2; branch chapter 3 joins 2's own way on, 5, which the layout puts in lane 0.
    const joinOff = buildStorylineLaneMap({
      rootChapterId: 1,
      chapters: [1, 2, 3, 5].map((id) =>
        id === 3
          ? { ...visible(id), post: { ...visible(id).post, username: 'civchan' } }
          : visible(id)
      ),
      edges: [
        { chapterId: 2, parentChapterId: 1, canon: true },
        { chapterId: 3, parentChapterId: 1, canon: false },
        { chapterId: 5, parentChapterId: 2, canon: false },
        { chapterId: 5, parentChapterId: 3, canon: false },
      ],
      truncated: false,
    })!;
    expect(joinOff.nodes.find((n) => n.chapterId === 5)?.lane).toBe(0);
    const { rows } = buildStorylineLaneList(joinOff, canonOf(joinOff, [1, 2]));
    const join = rows.flatMap((r) => r.bands).find((b) => b.kind === 'rejoin');
    expect(join).toMatchObject({ chapterId: 5, joining: 1, authors: ['civchan'] });
  });

  it('marks the canon forks from the canon path alone while there is no graph', () => {
    const canon = buildCanonLane(
      [1, 2, 3].map((id, depth) => ({ ...visible(id), depth, childCount: id === 2 ? 3 : 1 }))
    );
    const { rows, lanes } = buildStorylineLaneList(null, canon);
    expect(lanes).toBe(1);
    expect(rows.map((r) => r.bands)).toEqual([
      [],
      [],
      [expect.objectContaining({ kind: 'fork', chapterId: 2, number: 2, paths: 3, canon: true })],
    ]);
  });
});

describe('buildCanonLane', () => {
  it('numbers and links the canon path as the map would, naming the way in at a rejoin', () => {
    const path = [
      { ...visible(1), depth: 0 },
      { ...visible(2), depth: 1 },
      { ...visible(30), depth: 2, parentCount: 2 },
    ];
    expect(
      buildCanonLane(path).map(({ chapterId, row, lane, number, href }) => ({
        chapterId,
        row,
        lane,
        number,
        href,
      }))
    ).toEqual([
      { chapterId: 1, row: 0, lane: 0, number: 1, href: '/images/100?storylineChapter=1' },
      { chapterId: 2, row: 1, lane: 0, number: 2, href: '/images/200?storylineChapter=2' },
      {
        chapterId: 30,
        row: 2,
        lane: 0,
        number: 3,
        href: '/images/3000?storylineChapter=30&storylineVia=2',
      },
    ]);
  });
});

describe('getStorylinePathLanes', () => {
  const graph = { rootChapterId: 1, chapters: ids.map((chapterId) => ({ chapterId })), edges };
  const CANON = [1, 2, 3, 11, 12, 13, 30, 41, 42, 60];
  const pathOf = (route: number[]) =>
    route.map((chapterId) => ({ chapterId, onMain: CANON.includes(chapterId) }));

  it("gives a reader's off-main chapters the lane the map draws them in, and the main route none", () => {
    // Trunk, then branch B (21-23), then R1 and on along the canon.
    const lanes = getStorylinePathLanes(graph, pathOf([1, 2, 3, 21, 22, 23, 30, 41]));
    expect([...lanes]).toEqual([
      [21, 1],
      [22, 1],
      [23, 1],
    ]);
  });

  it('agrees with the lane the chapters list draws every chapter in', () => {
    const map = build(visible)!;
    const list = buildStorylineLaneList(
      map,
      CANON.map((id) => map.nodes.find((n) => n.chapterId === id)!)
    );
    const drawn = new Map(
      list.rows.flatMap((r) => [...r.branches].map((n) => [n.chapterId, n.lane] as const))
    );
    const lanes = getStorylinePathLanes(
      graph,
      ids.map((chapterId) => ({ chapterId, onMain: CANON.includes(chapterId) }))
    );
    expect(lanes.size).toBe(drawn.size);
    expect([...lanes].sort()).toEqual([...drawn].sort());
  });

  it('puts an off-main chapter the layout left in lane 0 in the spare lane, as the map does', () => {
    // Canon 2 is a leaf, so the layout hands lane 0 on to branch chapter 5 (see the list tests).
    const g = {
      rootChapterId: 1,
      chapters: [1, 2, 3, 4, 5].map((chapterId) => ({ chapterId })),
      edges: [
        { chapterId: 2, parentChapterId: 1, canon: true },
        { chapterId: 3, parentChapterId: 1, canon: false },
        { chapterId: 4, parentChapterId: 3, canon: true },
        { chapterId: 5, parentChapterId: 3, canon: false },
      ],
    };
    const lanes = getStorylinePathLanes(
      g,
      [1, 3, 5].map((chapterId) => ({ chapterId, onMain: chapterId === 1 }))
    );
    // The chapters list draws 3 and 4 in lane 1 and 5 in lane 2 (not lane 0, the canon column).
    expect([...lanes]).toEqual([
      [3, 1],
      [5, 2],
    ]);
  });

  it('is empty before the graph arrives, without chapter 1, or for chapters the graph lacks', () => {
    expect(getStorylinePathLanes(undefined, pathOf([1, 21])).size).toBe(0);
    expect(getStorylinePathLanes({ ...graph, rootChapterId: null }, pathOf([1, 21])).size).toBe(0);
    const capped = { ...graph, chapters: graph.chapters.filter((c) => c.chapterId !== 22) };
    expect([...getStorylinePathLanes(capped, pathOf([1, 2, 3, 21, 22]))]).toEqual([[21, 1]]);
  });
});

describe('laneColor', () => {
  it('names the lane colours in order, wrapping after the last', () => {
    expect(LANE_COLORS).toHaveLength(8);
    expect([0, 1, 4, 7, 8, 9].map(laneColor)).toEqual([
      'var(--mantine-color-blue-6)',
      'var(--mantine-color-grape-6)',
      'var(--mantine-color-pink-6)',
      'var(--mantine-color-yellow-6)',
      'var(--mantine-color-blue-6)',
      'var(--mantine-color-grape-6)',
    ]);
  });
});
