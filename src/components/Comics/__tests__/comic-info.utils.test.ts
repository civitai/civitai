// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  buildChapterCbz,
  buildComicInfoXml,
  browsingLevelToAgeRating,
} from '~/components/Comics/comic-info.utils';
import { NsfwLevel } from '~/server/common/enums';

const info = {
  title: 'Chapter One',
  series: 'My Comic',
  number: 3,
  writer: 'creator',
  web: 'https://civitai.com/comics/1/my-comic/3/chapter-one',
  pageCount: 12,
  nsfwLevel: NsfwLevel.PG,
};

function parse(xml: string) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc.documentElement;
}

describe('browsingLevelToAgeRating', () => {
  it.each([
    [0, 'Rating Pending'],
    [NsfwLevel.PG, 'Everyone'],
    [NsfwLevel.PG13, 'Teen'],
    [NsfwLevel.PG | NsfwLevel.PG13, 'Teen'],
    [NsfwLevel.R, 'Mature 17+'],
    [NsfwLevel.X, 'Adults Only 18+'],
    [NsfwLevel.XXX, 'Adults Only 18+'],
    [NsfwLevel.PG13 | NsfwLevel.X, 'Adults Only 18+'],
    [NsfwLevel.Blocked, 'Adults Only 18+'],
    [64, 'Adults Only 18+'],
  ])('rates nsfwLevel %i as %s', (level, rating) => {
    expect(browsingLevelToAgeRating(level)).toBe(rating);
  });
});

describe('buildComicInfoXml', () => {
  it('writes the fields in schema order, AgeRating from the chapter level', () => {
    const root = parse(buildComicInfoXml({ ...info, nsfwLevel: NsfwLevel.R }));
    expect(root.tagName).toBe('ComicInfo');
    expect(Array.from(root.children).map((el) => [el.tagName, el.textContent])).toEqual([
      ['Title', 'Chapter One'],
      ['Series', 'My Comic'],
      ['Number', '3'],
      ['Writer', 'creator'],
      ['Publisher', 'Civitai'],
      ['Web', 'https://civitai.com/comics/1/my-comic/3/chapter-one'],
      ['PageCount', '12'],
      ['AgeRating', 'Mature 17+'],
    ]);
  });

  it('omits Writer when the creator has no username', () => {
    const root = parse(buildComicInfoXml({ ...info, writer: null }));
    expect(root.getElementsByTagName('Writer')).toHaveLength(0);
    expect(root.getElementsByTagName('Publisher')[0].textContent).toBe('Civitai');
  });

  it('keeps emoji and drops a value that is only illegal characters', () => {
    const root = parse(buildComicInfoXml({ ...info, title: 'Ghost 👻', writer: '\u0001\u0002' }));
    expect(root.getElementsByTagName('Title')[0].textContent).toBe('Ghost 👻');
    expect(root.getElementsByTagName('Writer')).toHaveLength(0);
  });

  it('keeps hostile user strings as text, not markup', () => {
    // `&lt;` decodes to `<` if `&` goes unescaped, which a lenient parser would not report.
    const hostile = `A & &lt; <b>"x"</b> ']]> <!-- `;
    const xml = buildComicInfoXml({
      ...info,
      title: hostile,
      series: hostile,
      writer: hostile + '\u0001',
    });
    const root = parse(xml);
    expect(root.children).toHaveLength(8);
    // happy-dom accepts a raw `]]>` in text, so pin the escape on the string itself.
    expect(xml).not.toContain(']]>');
    for (const tag of ['Title', 'Series', 'Writer']) {
      expect(root.getElementsByTagName(tag)[0].textContent).toBe(hostile);
    }
  });
});

describe('buildChapterCbz', () => {
  it('puts ComicInfo.xml at the root, numbered, linked and rated from the chapter it is given', async () => {
    const page = { blob: new Blob([new Uint8Array([1, 2, 3])]), ext: 'png' };
    const chapter = {
      projectId: 7,
      projectName: 'My Comic',
      chapterName: 'Chapter One',
      chapterPosition: 2,
      chapterNsfwLevel: NsfwLevel.X,
      writer: 'creator',
    };
    const cbz = await buildChapterCbz([page, page], chapter, 'https://civitai.com');
    const zip = await JSZip.loadAsync(await cbz.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(['001.png', '002.png', 'ComicInfo.xml']);
    const root = parse(await zip.file('ComicInfo.xml')!.async('string'));
    const text = (tag: string) => root.getElementsByTagName(tag)[0]?.textContent;
    expect(text('Number')).toBe('3');
    expect(text('Web')).toBe('https://civitai.com/comics/7/my-comic/3/chapter-one');
    expect(text('PageCount')).toBe('2');
    expect(text('AgeRating')).toBe('Adults Only 18+');
  });
});
