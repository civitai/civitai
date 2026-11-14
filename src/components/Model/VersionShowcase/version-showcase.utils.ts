import type { RouterOutput } from '~/types/router';
import type { VersionShowcaseSite } from '~/shared/constants/version-showcase.constants';

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

/** The site's list as the carousel orders it: positioned items, then the rest in today's order. */
export function buildShowcaseItems(data: EditorData, site: VersionShowcaseSite): Item[] {
  const rows = data.rows.filter((row) => row.site === site);
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
    .filter((image) => image.site === site)
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
