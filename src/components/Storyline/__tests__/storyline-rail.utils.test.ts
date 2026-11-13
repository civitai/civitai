import { describe, expect, it } from 'vitest';
import { buildStorylineRail } from '~/components/Storyline/storyline-rail.utils';

type Chapter = {
  chapterId: number;
  depth: number;
  post: { id: number; title: string | null; userId: number; username: string | null } | null;
  childCount?: number;
  joins?: { chapterId: number }[];
};
const chapter = (chapterId: number, depth: number, extra: Partial<Chapter> = {}): Chapter => ({
  chapterId,
  depth,
  post: { id: chapterId * 100, title: null, userId: 1, username: 'owner' },
  childCount: 1,
  ...extra,
});

// A 30-image, 7-chapter path.
const SIZES = [4, 4, 5, 4, 4, 4, 5];
const PATH = SIZES.map((_, i) => chapter(10 + i, i));
const IMAGE_CHAPTERS = SIZES.flatMap((n, i) => Array<number>(n).fill(10 + i));

const rail = (index: number, extra: Partial<Parameters<typeof buildStorylineRail>[0]> = {}) =>
  buildStorylineRail<Chapter>({
    path: PATH,
    ahead: [],
    imageChapterIds: IMAGE_CHAPTERS,
    index,
    aheadKnown: true,
    ...extra,
  });

describe('buildStorylineRail', () => {
  it('draws a 30-image path as one segment per chapter, ticking only the current chapter', () => {
    const { segments } = rail(IMAGE_CHAPTERS.length - 2);
    expect(segments.map((s) => s.chapter.chapterId)).toEqual([10, 11, 12, 13, 14, 15, 16]);
    expect(segments.filter((s) => s.current).map((s) => s.chapter.chapterId)).toEqual([16]);
    expect(segments.find((s) => s.current)?.ticks).toEqual([25, 26, 27, 28, 29]);
    expect(segments.filter((s) => !s.current).every((s) => s.ticks.length === 0)).toBe(true);
  });

  it('keeps the same segments at every chapter, moving only the current one', () => {
    const first = rail(0).segments;
    const later = rail(13).segments;
    expect(later.map((s) => s.chapter.chapterId)).toEqual(first.map((s) => s.chapter.chapterId));
    expect(first.find((s) => s.current)?.chapter.chapterId).toBe(10);
    expect(later.find((s) => s.current)?.chapter.chapterId).toBe(13);
  });

  it('marks a chapter with a way on besides the next as leaving, and one with joins as joining', () => {
    const path = PATH.map((c) =>
      c.chapterId === 12
        ? { ...c, childCount: 2 }
        : c.chapterId === 16
        ? { ...c, childCount: 0, joins: [{ chapterId: 99 }] }
        : c
    );
    const { segments } = rail(0, { path });
    expect(segments.filter((s) => s.leaves).map((s) => s.chapter.chapterId)).toEqual([12]);
    expect(segments.filter((s) => s.joins).map((s) => s.chapter.chapterId)).toEqual([16]);
  });

  it("marks the line's last chapter as leaving on any way on, but not before the canon line ahead arrives", () => {
    // PATH's last chapter has one child. With nothing ahead on the canon line, that child is off it.
    expect(rail(0).segments.at(-1)?.leaves).toBe(true);
    expect(rail(0, { aheadKnown: false }).segments.at(-1)?.leaves).toBe(false);
    const ahead = [chapter(17, 7, { childCount: 0 })];
    const withAhead = rail(0, { ahead }).segments;
    expect(withAhead.map((s) => [s.chapter.chapterId, s.kind, s.leaves]).slice(-2)).toEqual([
      [16, 'path', false],
      [17, 'ahead', false],
    ]);
  });

  it('ticks carousel positions, so an off-path image leading the carousel shifts them', () => {
    // After a branch the carousel can lead with the image the reader was on, which is on no
    // chapter of the new path; a tick must still land on the image it is drawn for.
    const { segments } = rail(1, { imageChapterIds: [undefined, ...IMAGE_CHAPTERS] });
    expect(segments.find((s) => s.current)?.ticks).toEqual([1, 2, 3, 4]);
  });

  it('numbers the line from where the path starts, through the chapters ahead', () => {
    const path = [chapter(40, 5), chapter(41, 6)];
    const { segments } = rail(0, { path, imageChapterIds: [40], ahead: [chapter(42, 0)] });
    expect(segments.map((s) => s.depth)).toEqual([5, 6, 7]);
  });

  it('gives each path chapter off the main route its map lane, and no other segment one', () => {
    const laneOf = new Map([
      [14, 2],
      [15, 2],
      [16, 4],
    ]);
    const ahead = [chapter(17, 7, { childCount: 0 })];
    const { segments } = rail(0, { laneOf, ahead });
    expect(segments.map((s) => [s.chapter.chapterId, s.lane])).toEqual([
      [10, null],
      [11, null],
      [12, null],
      [13, null],
      [14, 2],
      [15, 2],
      [16, 4],
      // The canon line ahead is the main route: never coloured, even for an id the map holds.
      [17, null],
    ]);
    expect(rail(0, { laneOf: new Map([[17, 3]]), ahead }).segments.at(-1)?.lane).toBeNull();
  });

  it('leaves every segment plain until the lanes are known', () => {
    expect(rail(0).segments.map((s) => s.lane)).toEqual(Array(7).fill(null));
    expect(rail(0, { laneOf: new Map() }).segments.map((s) => s.lane)).toEqual(Array(7).fill(null));
  });

  it('shows a window around the current chapter on a long line', () => {
    const path = Array.from({ length: 40 }, (_, i) => chapter(100 + i, i));
    const { segments, clippedStart, clippedEnd } = rail(0, {
      path,
      imageChapterIds: [130],
      window: 10,
    });
    expect(segments.map((s) => s.chapter.chapterId)).toEqual([
      125, 126, 127, 128, 129, 130, 131, 132, 133, 134,
    ]);
    expect([clippedStart, clippedEnd]).toEqual([true, true]);
    const atEnd = rail(0, { path, imageChapterIds: [139], window: 10 });
    expect(atEnd.segments.at(-1)?.chapter.chapterId).toBe(139);
    expect([atEnd.segments.length, atEnd.clippedStart, atEnd.clippedEnd]).toEqual([
      10,
      true,
      false,
    ]);
  });
});
