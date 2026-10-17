import { describe, expect, it } from 'vitest';
import {
  buildStorylineLaneMap,
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
    expect(node(hidden, 22)).toMatchObject({ href: null, name: 'This chapter is not available' });
    // Control: a chapter with a post but no image this reader may see opens its post.
    const noImage = build((id) => (id === 22 ? { ...visible(22), firstImage: null } : visible(id)));
    expect(node(noImage, 22)?.href).toBe('/posts/220');
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
