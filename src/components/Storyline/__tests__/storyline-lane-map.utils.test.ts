import { describe, expect, it } from 'vitest';
import {
  buildCanonLane,
  buildStorylineLaneMap,
  buildStorylineLaneRows,
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

describe('buildStorylineLaneRows', () => {
  // The demo story, with B's chapters by a second author so the join can name them.
  const map = build((id) =>
    [21, 22, 23].includes(id)
      ? { ...visible(id), post: { ...visible(id).post, username: 'civchan' } }
      : visible(id)
  );
  const rows = buildStorylineLaneRows(map!.layout, map!.nodes);
  const shape = rows.map((r) => ({
    canon: r.canon?.chapterId ?? null,
    branches: r.branches.map((n) => n.chapterId),
    bands: r.bands.map((b) => (b.kind === 'fork' ? `fork@${b.chapterId}` : `join@${b.chapterId}`)),
  }));

  it('puts the canon path down lane 0 and the other paths beside it, row by row', () => {
    expect(shape.map((r) => [r.canon, ...r.branches])).toEqual([
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
    expect(shape.map((r) => r.bands)).toEqual([
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
  });

  it('names the fork by the chapter it follows and lists its ways on canon first', () => {
    expect(rows[3].bands[0]).toMatchObject({ kind: 'fork', number: 3, childIds: [11, 21] });
  });

  it('names who wrote the path that joins, not the one it joins', () => {
    expect(rows[6].bands[0]).toMatchObject({ kind: 'rejoin', joining: 1, authors: ['civchan'] });
    expect(rows[10].bands[0]).toMatchObject({ kind: 'rejoin', joining: 1, authors: ['author'] });
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
