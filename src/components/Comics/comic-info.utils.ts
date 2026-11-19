import { NsfwLevel } from '~/server/common/enums';

// ComicInfo.xml (https://anansi-project.github.io/docs/comicinfo/intro): the metadata file comic
// readers (Komga, Kavita, ComicRack...) read from the root of a CBZ.

export type ComicInfoAgeRating =
  | 'Rating Pending'
  | 'Everyone'
  | 'Teen'
  | 'Mature 17+'
  | 'Adults Only 18+';

/** Fails closed: X, XXX, Blocked or any unknown bit rates the archive adults-only. */
export function browsingLevelToAgeRating(nsfwLevel: number): ComicInfoAgeRating {
  if (nsfwLevel === 0) return 'Rating Pending';
  if (!Number.isInteger(nsfwLevel) || nsfwLevel & ~(NsfwLevel.PG | NsfwLevel.PG13 | NsfwLevel.R))
    return 'Adults Only 18+';
  if (nsfwLevel & NsfwLevel.R) return 'Mature 17+';
  if (nsfwLevel & NsfwLevel.PG13) return 'Teen';
  return 'Everyone';
}

// Characters XML 1.0 forbids even when escaped; one in a title would make the file unparseable.
const XML_ILLEGAL_CHARS = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

export function escapeXml(value: string) {
  return value
    .replace(XML_ILLEGAL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export type ComicInfo = {
  title: string;
  series: string;
  number: number;
  writer: string | null;
  web: string;
  pageCount: number;
  nsfwLevel: number;
};

/** The chapter as a CBZ: pages `001.ext`, `002.ext`, ... then ComicInfo.xml, all at the root. */
export async function buildChapterCbz(
  images: { blob: Blob; ext: string }[],
  info: Omit<ComicInfo, 'pageCount'>
) {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  images.forEach(({ blob, ext }, i) => zip.file(`${String(i + 1).padStart(3, '0')}.${ext}`, blob));
  zip.file('ComicInfo.xml', buildComicInfoXml({ ...info, pageCount: images.length }));
  return zip.generateAsync({ type: 'blob' });
}

export function buildComicInfoXml(info: ComicInfo) {
  // Order follows the schema's xs:sequence; strict readers reject elements out of order.
  const fields: [string, string | number | null][] = [
    ['Title', info.title],
    ['Series', info.series],
    ['Number', info.number],
    ['Writer', info.writer],
    ['Publisher', 'Civitai'],
    ['Web', info.web],
    ['PageCount', info.pageCount],
    ['AgeRating', browsingLevelToAgeRating(info.nsfwLevel)],
  ];
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    ...fields
      .filter(([, value]) => value != null && value !== '')
      .map(([tag, value]) => `  <${tag}>${escapeXml(String(value))}</${tag}>`),
    '</ComicInfo>',
    '',
  ].join('\n');
}
