// JUNK_TAGS and the category lists match exactly (case and _/space folded); entries typed into
// "Never apply" also drop longer tags starting with their words (trailing-s folded), so "boyshorts"
// catches "boyshort panties".

/** Pre-filled into "Never apply" as removable chips: quality and provenance tags the creator should
 *  choose for themselves. */
export const JUNK_TAGS: readonly string[] = [
  'lowres',
  'worst quality',
  'bad quality',
  'normal quality',
  'best quality',
  'anime screenshot',
  'official art',
  'oekaki',
  'non-web source',
  'stitched',
  'parody',
  'style parody',
  'third-party edit',
  'third-party source',
  'meme',
];

export interface TagCategories {
  character: ReadonlySet<string>;
  source: ReadonlySet<string>;
}

export interface ExcludeOptions {
  /** The "Never apply" list: JUNK_TAGS entries left in it plus whatever the creator typed. */
  never: readonly string[];
  /** Null until loadTagCategories resolves, or if it failed; the switches then have nothing to match. */
  categories: TagCategories | null;
  excludeCharacter: boolean;
  excludeSource: boolean;
}

export type TagExcluder = (tag: string) => boolean;

export function normTag(tag: string): string {
  return tag.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

const JUNK = new Set(JUNK_TAGS.map(normTag));
const singular = (w: string) => (w.length > 1 && w.endsWith('s') ? w.slice(0, -1) : w);

export function buildTagExcluder(opts: ExcludeOptions): TagExcluder {
  const exact = new Set<string>();
  const prefixes: string[][] = [];
  for (const entry of opts.never) {
    const n = normTag(entry);
    if (!n) continue;
    exact.add(n);
    if (!JUNK.has(n)) prefixes.push(n.split(' ').map(singular));
  }
  const { categories } = opts;
  return (tag) => {
    const n = normTag(tag);
    if (exact.has(n)) return true;
    if (opts.excludeCharacter && categories?.character.has(n)) return true;
    if (opts.excludeSource && categories?.source.has(n)) return true;
    const words = n.split(' ').map(singular);
    return prefixes.some((p) => p.length <= words.length && p.every((w, i) => w === words[i]));
  };
}

let categoriesLoad: Promise<TagCategories> | null = null;

/** The tagger's Character and Copyright names (a large JSON), split into its own chunk and fetched once,
 *  before the first auto-label result is merged. Regenerate with scripts/gen-tag-categories.mjs. */
export function loadTagCategories(): Promise<TagCategories> {
  categoriesLoad ??= import('./data/tag-categories.json')
    .then((m) => {
      const data = (m.default ?? m) as { character: string[]; source: string[] };
      return { character: new Set(data.character), source: new Set(data.source) };
    })
    .catch((err) => {
      categoriesLoad = null; // let the next run retry rather than caching the failure
      throw err;
    });
  return categoriesLoad;
}
