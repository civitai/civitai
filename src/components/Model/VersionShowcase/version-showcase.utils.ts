import type { RouterOutput } from '~/types/router';
import type { VersionShowcaseSite } from '~/shared/constants/version-showcase.constants';
import { isComSafeLevel } from '~/shared/utils/model-sfw-face';

type EditorData = RouterOutput['versionShowcase']['getEditor'];

export type Item = {
  imageId: number;
  source: 'Owner' | 'Community';
  excluded: boolean;
  url?: string;
  type?: string;
  metadata?: unknown;
  nsfwLevel?: number;
  author?: string | null;
};

export const siteLabel: Record<VersionShowcaseSite, string> = {
  com: 'civitai.com',
  red: 'civitai.red',
};

/** The other site, when only it is curated: this site then serves that showcase. */
export function inheritedSite(
  data: Pick<EditorData, 'rows'>,
  site: VersionShowcaseSite
): VersionShowcaseSite | null {
  const other: VersionShowcaseSite = site === 'com' ? 'red' : 'com';
  const curated = (s: VersionShowcaseSite) => data.rows.some((row) => row.site === s);
  return !curated(site) && curated(other) ? other : null;
}

/**
 * Whether "Make cover" is offered: an image showing on the latest published version, rated for the
 * site, and, if featured, saved in this site's own showcase (the server accepts no other).
 */
export function canBeCover(
  data: Pick<EditorData, 'rows' | 'isLatestPublished'>,
  site: VersionShowcaseSite,
  item: Item
) {
  return (
    data.isLatestPublished &&
    !item.excluded &&
    !!item.url &&
    !(item.source === 'Community' && inheritedSite(data, site)) &&
    (site !== 'com' || item.nsfwLevel === undefined || isComSafeLevel(item.nsfwLevel))
  );
}

/** The site's list as the carousel orders it: positioned items, then the rest in today's order. */
export function buildShowcaseItems(data: EditorData, site: VersionShowcaseSite): Item[] {
  const source = inheritedSite(data, site) ?? site;
  const rows = data.rows.filter((row) => row.site === source);
  const rowById = new Map(rows.map((row) => [row.imageId, row]));
  const owner: Item[] = data.ownerImages.map((image) => ({
    imageId: image.id,
    source: 'Owner',
    excluded: !!rowById.get(image.id)?.excluded,
    url: image.url,
    type: image.type,
    metadata: image.metadata,
    nsfwLevel: image.nsfwLevel,
  }));
  const community: Item[] = data.community
    .filter((image) => image.site === source && (site !== 'com' || isComSafeLevel(image.nsfwLevel)))
    .map((image) => ({
      imageId: image.id,
      source: 'Community',
      excluded: false,
      url: image.url,
      type: image.type,
      metadata: image.metadata,
      nsfwLevel: image.nsfwLevel,
      author: image.authorUsername,
    }));
  const all = [...owner, ...community];
  const position = (item: Item) => rowById.get(item.imageId)?.position ?? null;
  const positioned = all
    .filter((item) => position(item) !== null)
    .sort((a, b) => (position(a) as number) - (position(b) as number));
  return [...positioned, ...all.filter((item) => position(item) === null)];
}

/** The image id in a pasted image link or a bare number. */
export function parseImageId(value: string) {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/\/images\/(\d+)\/?(?:[?#].*)?$/);
  return match ? Number(match[1]) : null;
}
