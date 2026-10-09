import { describe, expect, test } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';

/**
 * Every card a feed grid renders must report impressions.
 *
 * Impressions used to be wired card by card, and the cards that were never wired
 * (the /images feed, model galleries, hubs) silently recorded nothing while the
 * feature doc claimed full coverage. Nothing failed, because an untracked card
 * looks exactly like a tracked one that nobody scrolled past.
 *
 * So this guard starts from the GRIDS, not from a list of cards: it finds every
 * `render={…}` handed to a masonry/uniform grid, resolves the component, and
 * fails unless that component tracks, either directly or by rendering a shell
 * that does (AspectRatioImageCard, AspectRatioCard, FeedCard, ElementInView with
 * `impressions`). A new card dropped into a feed is caught here without anyone
 * remembering to add it to a list.
 *
 * It is a source scan, not a render: the component harness runs in no CI job,
 * and the unit project has no IntersectionObserver to drive.
 */

const SRC = resolve(__dirname, '..', '..', '..');
const toKey = (file: string) => relative(SRC, file).split('\\').join('/');

// Text that means "this file reports impressions itself".
const DIRECT_MARKERS = [
  /\buseTrackImpression\b\s*(<[^>]*>)?\s*\(/,
  /\bimpressions=\{/,
  /\bimpression=\{/,
  /<ImpressionSentinel\b/,
];

// Grids that are not feeds, and the reason. Keep this short: every entry is a
// place an impression can never be recorded.
const EXEMPT: Record<string, string> = {
  'components/Account/HiddenTagsSection.tsx:TagBadge': 'settings list of hidden tags',
  'components/Account/HiddenUsersSection.tsx:UserBadge': 'settings list of hidden users',
  'components/Csam/CsamImageSelection.tsx:CsamImageCard': 'moderation tool',
  'components/Games/NewOrder/JudgmentHistory.tsx:JudgmentHistoryItem': 'game history, not a feed',
  'components/ImageGeneration/GenerationForm/ResourceSelectModal/ResourceHitList.tsx:<inline>':
    'generator resource picker',
  'components/Model/ModelDiscussion/ModelDiscussionV2.tsx:<inline>': 'comment threads',
  'components/ResourceReview/ResourceReviewsGrid.tsx:ResourceReviewCard':
    'reviews are not an impression entity type',
  'components/Tool/ToolsInfinite.tsx:ToolCard': 'tools are not an impression entity type',
  // A caller-supplied card replaces ImagesCard; today only the challenge and
  // collection submission pickers pass one.
  'components/Image/Infinite/ImagesInfinite.tsx:MasonryItem': 'picker modals only',
  'pages/collections/[collectionId]/review.tsx:CollectionItemGridItem': 'moderation review queue',
  'pages/moderator/research/rater-sanity.tsx:ImageGridItem': 'moderator tool',
};

const GRID_IMPORT = /from '~\/components\/(MasonryColumns|MasonryGrid)\//;
// The grids themselves forward a `render` prop internally.
const GRID_DIR = /^components\/(MasonryColumns|MasonryGrid)\//;
const isGridCaller = (file: string, source: string) =>
  GRID_IMPORT.test(source) && !GRID_DIR.test(toKey(file));

export type SourceTree = Map<string, string>; // absolute path -> contents

function walk(dir: string, out: SourceTree) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.set(full, readFileSync(full, 'utf-8'));
    }
  }
  return out;
}

function resolveModule(fromFile: string, spec: string, tree: SourceTree): string | undefined {
  let base: string;
  if (spec.startsWith('~/')) base = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return undefined;
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    join(base, 'index.tsx'),
    join(base, 'index.ts'),
  ]) {
    if (tree.has(candidate) || (existsSync(candidate) && statSync(candidate).isFile()))
      return candidate;
  }
  return undefined;
}

/** The file that defines `name` as seen from `file`: an import, or `file` itself. */
function resolveIdentifier(file: string, name: string, tree: SourceTree): string | undefined {
  const source = tree.get(file) ?? '';
  for (const m of source.matchAll(/import\s+(?:type\s+)?([^;]*?)\s+from\s+'([^']+)'/g)) {
    const clause = m[1];
    const named = clause.match(/\{([^}]*)\}/)?.[1] ?? '';
    const locals = named
      .split(',')
      .map(
        (s) =>
          s
            .trim()
            .split(/\s+as\s+/)
            .pop()!
      )
      .filter(Boolean);
    const defaultName = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, '')
      .trim();
    if (locals.includes(name) || defaultName === name) return resolveModule(file, m[2], tree);
  }
  const local = new RegExp(String.raw`(function|const|let)\s+${name}\b`);
  return local.test(source) ? file : undefined;
}

function read(file: string, tree: SourceTree) {
  if (!tree.has(file) && existsSync(file)) tree.set(file, readFileSync(file, 'utf-8'));
  return tree.get(file) ?? '';
}

// Shells that track only when their caller passes `impressions`. Rendering one
// proves nothing, so they never count as coverage for the card that renders
// them; the card has to pass the prop, which is a direct marker in its own file.
const PROP_DEPENDENT_SHELLS = new Set(
  [
    'components/IntersectionObserver/ElementInView.tsx',
    'components/CardTemplates/AspectRatioCard.tsx',
    'components/Cards/FeedCard.tsx',
  ].map((path) => join(SRC, path))
);

/**
 * Tracked directly, or renders a component that is. One level of indirection is
 * enough for every card today (ModelCard -> AspectRatioImageCard) and keeps a
 * card from passing because something far below it happens to track.
 */
function isTracked(file: string, tree: SourceTree, depth = 1): boolean {
  const source = read(file, tree);
  if (DIRECT_MARKERS.some((re) => re.test(source))) return true;
  if (depth === 0) return false;
  const tags = new Set(Array.from(source.matchAll(/<([A-Z][\w$]*)[\s/>]/g), (m) => m[1]));
  for (const tag of tags) {
    const target = resolveIdentifier(file, tag, tree);
    if (!target || target === file || PROP_DEPENDENT_SHELLS.has(target)) continue;
    if (isTracked(target, tree, depth - 1)) return true;
  }
  return false;
}

function renderExpressions(source: string): string[] {
  const out: string[] = [];
  let at = source.indexOf('render={');
  while (at !== -1) {
    let depth = 0;
    let i = at + 'render='.length;
    for (; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}' && --depth === 0) break;
    }
    out.push(source.slice(at + 'render={'.length, i).trim());
    at = source.indexOf('render={', i);
  }
  return out;
}

/** `file:Card` for every grid card that does not report impressions. */
export function findUntrackedFeedCards(tree: SourceTree, exempt = EXEMPT): string[] {
  const untracked = new Set<string>();
  for (const [file, source] of tree) {
    if (!isGridCaller(file, source)) continue;
    for (const expr of renderExpressions(source)) {
      const identifiers = /^[\w$]+(\s*\?\?\s*[\w$]+)*$/.test(expr)
        ? expr.split('??').map((s) => s.trim())
        : [];
      // An inline function, or a callback defined in this file: the call site
      // is what renders the card, so the call site is what must track.
      const cards = identifiers.filter((id) => /^[A-Z]/.test(id));
      const targets = cards.length ? cards : ['<inline>'];
      for (const card of targets) {
        const key = `${toKey(file)}:${card}`;
        if (key in exempt) continue;
        const target = card === '<inline>' ? file : resolveIdentifier(file, card, tree);
        if (!target || !isTracked(target, tree)) untracked.add(key);
      }
    }
  }
  return Array.from(untracked).sort();
}

const realTree = () => walk(SRC, new Map());

describe('feed cards report impressions', () => {
  test('every card handed to a feed grid tracks, or is exempt with a reason', () => {
    expect(findUntrackedFeedCards(realTree())).toEqual([]);
  });

  test('the scan finds the feeds it exists for', () => {
    // A scan that matched no grids would pass the test above vacuously.
    const tree = realTree();
    const seen: string[] = [];
    for (const [file, source] of tree)
      if (isGridCaller(file, source) && renderExpressions(source).length) seen.push(toKey(file));
    expect(seen).toEqual(
      expect.arrayContaining([
        'components/Image/Infinite/ImagesInfinite.tsx',
        'components/Image/AsPosts/ImagesAsPostsInfinite.tsx',
        'components/Post/Infinite/PostsInfinite.tsx',
        'components/Model/Infinite/ModelsInfinite.tsx',
        'pages/search/images.tsx',
      ])
    );
  });

  test('every exemption still names a real grid card', () => {
    // A stale exemption is a hole waiting for the next card with that name.
    const tree = realTree();
    const live = new Set<string>();
    for (const [file, source] of tree) {
      if (!isGridCaller(file, source)) continue;
      for (const expr of renderExpressions(source)) {
        const ids = /^[\w$]+(\s*\?\?\s*[\w$]+)*$/.test(expr)
          ? expr
              .split('??')
              .map((s) => s.trim())
              .filter((id) => /^[A-Z]/.test(id))
          : [];
        for (const id of ids.length ? ids : ['<inline>']) live.add(`${toKey(file)}:${id}`);
      }
    }
    expect(Object.keys(EXEMPT).filter((key) => !live.has(key))).toEqual([]);
  });

  // Cards outside a grid's render prop, so the scan above cannot reach them.
  test.each([
    'components/Image/Infinite/ImagesCard.tsx',
    'components/Image/AsPosts/ImagesAsPostsCard.tsx',
    'components/Post/Infinite/PostsCard.tsx',
    'components/CreatorShop/Storefront/ModelShopCard.tsx',
    'components/Model/ModelCarousel/ModelCarousel.tsx',
    'pages/ecosystems/[key]/index.tsx',
    'components/CardTemplates/AspectRatioImageCard.tsx',
    'components/CardTemplates/AspectRatioCard.tsx',
    'components/Cards/FeedCard.tsx',
  ])('%s reports impressions itself', (path) => {
    expect(isTracked(join(SRC, path), new Map(), 0)).toBe(true);
  });

  test('ElementInView forwards `impressions` to useTrackImpression', () => {
    const source = readFileSync(
      join(SRC, 'components/IntersectionObserver/ElementInView.tsx'),
      'utf-8'
    );
    expect(source).toMatch(/useTrackImpression<[^>]*>\(impressions\)/);
    expect(source).toMatch(/useMergedRef\([^)]*impressionRef/);
  });
});

describe('the guard can fail', () => {
  const card = (body: string) => `export function Card() { return ${body}; }`;
  const grid = (render: string) =>
    `import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';\n` +
    `import { Card } from './Card';\n` +
    `export function Feed() { return <MasonryColumns render={${render}} />; }`;
  const fixture = (cardSource: string, render = 'Card') =>
    new Map([
      [join(SRC, 'fixture/Feed.tsx'), grid(render)],
      [join(SRC, 'fixture/Card.tsx'), cardSource],
    ]);

  test('an untracked card in a feed is reported by name', () => {
    expect(findUntrackedFeedCards(fixture(card('<div />')), {})).toEqual(['fixture/Feed.tsx:Card']);
  });

  test('a card that tracks directly passes', () => {
    const tracked = card(
      `<div ref={useTrackImpression([{ entityType: 'Image', entityId: 1 }])} />`
    );
    expect(findUntrackedFeedCards(fixture(tracked), {})).toEqual([]);
  });

  test('rendering ElementInView without `impressions` is not coverage', () => {
    const shell =
      `import { ElementInView } from '~/components/IntersectionObserver/ElementInView';\n` +
      card('<ElementInView component="div" />');
    expect(findUntrackedFeedCards(fixture(shell), {})).toEqual(['fixture/Feed.tsx:Card']);
  });

  test('an inline render function that renders an untracked card is reported', () => {
    expect(findUntrackedFeedCards(fixture(card('<div />'), '(p) => <Card {...p} />'), {})).toEqual([
      'fixture/Feed.tsx:<inline>',
    ]);
  });
});
