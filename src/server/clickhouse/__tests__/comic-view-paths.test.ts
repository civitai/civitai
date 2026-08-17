import { describe, expect, it } from 'vitest';
import {
  chapterKey,
  parseComicPageId,
  resolveChapterId,
} from '~/server/clickhouse/comic-view-paths';

// Every path below is a real `pageViews.pageId` shape observed in prod, including the probe
// string. Classification decides what the backfilled numbers mean, and the two ways it can go
// wrong are both silent: the studio surface folded into reader views inflates every comic a
// creator edits, and a reader path dropped to `other` deflates it. Neither shows up as an error.
describe('parseComicPageId', () => {
  it('reads the project id off an overview path, with or without a slug', () => {
    expect(parseComicPageId('/comics/3203')).toEqual({ kind: 'project', projectId: 3203 });
    expect(parseComicPageId('/comics/3203/slutty-kate')).toEqual({
      kind: 'project',
      projectId: 3203,
    });
  });

  it('reads project id and 1-indexed position off a chapter path', () => {
    expect(parseComicPageId('/comics/3318/the-incredulous/1/chapter-1')).toEqual({
      kind: 'chapter',
      projectId: 3318,
      urlPosition: 1,
    });
    expect(parseComicPageId('/comics/1488/some-comic/12/finale')).toEqual({
      kind: 'chapter',
      projectId: 1488,
      urlPosition: 12,
    });
  });

  it('excludes the authoring studio, which carries a project id but is not a read', () => {
    // /comics/project/<id>/* is the creator editing their own comic — ~10k views/30d against
    // ~236k reader views. Counting it would credit authors for their own editing sessions.
    for (const path of [
      '/comics/project/3203',
      '/comics/project/1488/chapter/2',
      '/comics/project/3034/iterate',
      '/comics/project/2121/character',
      '/comics/project/1488/read',
    ]) {
      expect(parseComicPageId(path), path).toEqual({ kind: 'other' });
    }
  });

  it('excludes paths carrying no project id', () => {
    for (const path of ['/comics', '/comics/browse', '/comics/create']) {
      expect(parseComicPageId(path), path).toEqual({ kind: 'other' });
    }
  });

  it('rejects a non-numeric id rather than coercing it', () => {
    // pageIds in this column include injection probes. An unanchored or non-digit pattern would
    // turn one into entityId NaN/0 and write it.
    const probe = "/comics'||DBMS_PIPE.RECEIVE_MESSAGE(CHR(98)||CHR(98)||CHR(98),15)||'";
    expect(parseComicPageId(probe)).toEqual({ kind: 'other' });
    expect(parseComicPageId('/comics/abc')).toEqual({ kind: 'other' });
    expect(parseComicPageId('/comics/3203abc')).toEqual({ kind: 'other' });
  });

  it('falls back to project for any other path under /comics/<id>/, as the page does', () => {
    // The page reads the position from slug[1]. When that is not a number it renders the
    // OVERVIEW, so these are project views, not chapter reads and not nothing. Prod has 663 of
    // the slug-less shape; they used to match neither pattern and vanish before the pipeline,
    // where even the unmapped counter could not see them.
    expect(parseComicPageId('/comics/3156/1/chapter-1')).toEqual({
      kind: 'project',
      projectId: 3156,
    });
    expect(parseComicPageId('/comics/2502#')).toEqual({ kind: 'project', projectId: 2502 });
    expect(parseComicPageId('/comics/424/slug/deep/deeper')).toEqual({
      kind: 'project',
      projectId: 424,
    });
  });

  it('requires a delimiter after the chapter position', () => {
    // Without the trailing (/|?|#|$) anchor, '/comics/424/slug/12abc' parses as position 12 —
    // a real number attributed to a chapter the URL never named.
    expect(parseComicPageId('/comics/424/slug/12abc')).toEqual({
      kind: 'project',
      projectId: 424,
    });
    expect(parseComicPageId('/comics/424/slug/12/name')).toEqual({
      kind: 'chapter',
      projectId: 424,
      urlPosition: 12,
    });
  });
});

describe('resolveChapterId', () => {
  const map = new Map([
    [chapterKey(42, 0), 900],
    [chapterKey(42, 1), 901],
    [chapterKey(99, 0), 950],
  ]);

  it('shifts the 1-indexed URL position onto the 0-indexed DB position', () => {
    // Off by one here silently attributes every chapter's views to the previous chapter, and
    // drops chapter 1 entirely — a plausible-looking result with no error anywhere.
    expect(resolveChapterId(map, 42, 1)).toBe(900);
    expect(resolveChapterId(map, 42, 2)).toBe(901);
  });

  it('returns undefined for a position with no current chapter', () => {
    expect(resolveChapterId(map, 42, 3)).toBeUndefined();
    expect(resolveChapterId(map, 7, 1)).toBeUndefined();
  });

  it('does not let position 0 wrap onto another project', () => {
    // A 0 would key -1, which must miss rather than resolve to anything.
    expect(resolveChapterId(map, 42, 0)).toBeUndefined();
  });
});
