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
 * `render={…}` handed to a component from `~/components/MasonryColumns` or
 * `~/components/MasonryGrid`, resolves the card COMPONENT (not just its file),
 * and fails unless that component tracks itself or renders a component that
 * does. A shell that tracks only what its caller passes (ElementInView,
 * AspectRatioCard, AspectRatioImageCard, FeedCard) never counts on its own: the
 * card has to pass `impressions`/`impression`.
 *
 * It checks that a card tracks, not WHICH entity it reports; that choice is
 * reviewed with the card.
 *
 * Its reach is the grids' `render` prop. A feed built some other way (a `.map()`
 * into a plain grid) is not seen here, which is what the named list at the
 * bottom is for.
 *
 * It is a source scan, not a render: the component harness runs in no CI job,
 * and the unit project has no IntersectionObserver to drive.
 */

const SRC = resolve(__dirname, '..', '..', '..');
const toKey = (file: string) => relative(SRC, file).split('\\').join('/');

// What "this component reports impressions itself" looks like. An empty or
// undefined `impressions` records nothing, so it is not a marker.
const PROP_MARKERS = [
  /\bimpressions?=\{(?!\s*(undefined|null|\[\s*\])\s*\})/,
  /<ImpressionSentinel\b/,
];

/**
 * The hook only records once its ref is on an element, so a call whose ref is
 * never used is not a marker: `const r = useTrackImpression(…)` needs `r` again.
 */
function callsTrackingHook(body: string): boolean {
  const assigned = Array.from(
    body.matchAll(/\bconst\s+([\w$]+)\s*=\s*useTrackImpression\b/g),
    (m) => m[1]
  );
  // Attached as a ref, or merged into one; a bare mention elsewhere is not use.
  const usedAgain = (ref: string) =>
    new RegExp(String.raw`ref=\{\s*${ref}\s*\}|useMergedRef\([^)]*\b${ref}\b`).test(body);
  return assigned.some(usedAgain) || /ref=\{\s*useTrackImpression\b/.test(body);
}

const tracksDirectly = (body: string) =>
  callsTrackingHook(body) || PROP_MARKERS.some((re) => re.test(body));

// Shells that track only what their caller passes. Rendering one proves
// nothing; the caller must pass the prop, which is a marker in its own body.
const PROP_DEPENDENT_SHELLS = new Set(
  [
    'components/IntersectionObserver/ElementInView.tsx',
    'components/CardTemplates/AspectRatioCard.tsx',
    'components/CardTemplates/AspectRatioImageCard.tsx',
    'components/Cards/FeedCard.tsx',
  ].map((path) => join(SRC, path))
);

// Grid cards that do not report impressions of their own, and why. Keep this
// short and specific: every entry is a place the guard has stopped looking.
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
  // These record their cover Image through AspectRatioImageCard's `image`, but
  // pass no `impression` of their own: their entity is not an impression type.
  'components/Challenge/Infinite/ChallengesInfinite.tsx:ChallengeCard': 'cover image only',
  'components/Comics/ComicsInfinite.tsx:ComicCard': 'cover image only',
  'components/Crucible/CruciblesInfinite.tsx:CrucibleCard': 'cover image only',
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
type Component = { file: string; name: string };

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

// A marker in a comment tracks nothing. Keeps `'https://…'` inside strings.
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

function read(file: string, tree: SourceTree) {
  if (!tree.has(file) && existsSync(file)) tree.set(file, readFileSync(file, 'utf-8'));
  return stripComments(tree.get(file) ?? '');
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

/** The component `name` refers to inside `file`: an import, or a local definition. */
function resolveComponent(file: string, name: string, tree: SourceTree): Component | undefined {
  const source = read(file, tree);
  for (const m of source.matchAll(/import\s+(?:type\s+)?([^;]*?)\s+from\s+'([^']+)'/g)) {
    const clause = m[1];
    const named = clause.match(/\{([^}]*)\}/)?.[1] ?? '';
    for (const spec of named.split(',')) {
      const [original, local = original] = spec.trim().split(/\s+as\s+/);
      if (local === name) {
        const target = resolveModule(file, m[2], tree);
        return target ? { file: target, name: original } : undefined;
      }
    }
    const defaultName = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, '')
      .trim();
    if (defaultName === name) {
      const target = resolveModule(file, m[2], tree);
      return target ? { file: target, name: 'default' } : undefined;
    }
  }
  return new RegExp(String.raw`(function|const|let)\s+${name}\b`).test(source)
    ? { file, name }
    : undefined;
}

const TOP_LEVEL =
  /\n(?=(export\s+)?(default\s+)?(async\s+)?(function|const|let|class|type|interface)\b)/g;

/** The source of one top-level component, so a sibling's marker cannot vouch for it. */
function componentBody({ file, name }: Component, tree: SourceTree): string | undefined {
  const source = read(file, tree);
  const decl =
    name === 'default'
      ? /(^|\n)export\s+default\b/
      : new RegExp(String.raw`(^|\n)(export\s+)?(default\s+)?(function|const|let)\s+${name}\b`);
  const start = source.search(decl);
  if (start === -1) return undefined;
  TOP_LEVEL.lastIndex = start + 1;
  const next = TOP_LEVEL.exec(source);
  return source.slice(start, next ? next.index : source.length);
}

/**
 * Tracked in its own body, or renders a component that is. One level of
 * indirection covers every card today (ImagesCard -> ImagesCardContent) and
 * stops a card passing because something far below it tracks something else.
 * `memo(X)` is followed without spending that level.
 */
function isTracked(component: Component, tree: SourceTree, depth = 1): boolean {
  const body = componentBody(component, tree);
  if (body === undefined) return false;
  const memoOf = body.match(/=\s*(?:React\.)?memo\(\s*([A-Z][\w$]*)/)?.[1];
  if (memoOf) {
    const inner = resolveComponent(component.file, memoOf, tree);
    return !!inner && isTracked(inner, tree, depth);
  }
  if (tracksDirectly(body)) return true;
  if (depth === 0) return false;
  return rendersTracked(component.file, body, tree, depth - 1);
}

function rendersTracked(file: string, jsx: string, tree: SourceTree, depth: number) {
  const tags = new Set(Array.from(jsx.matchAll(/<([A-Z][\w$]*)[\s/>]/g), (m) => m[1]));
  for (const tag of tags) {
    const child = resolveComponent(file, tag, tree);
    if (!child || PROP_DEPENDENT_SHELLS.has(child.file)) continue;
    if (isTracked(child, tree, depth)) return true;
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

/** The cards a `render={…}` names: identifiers, or `<inline>` for anything else. */
function renderTargets(expr: string): string[] {
  if (!/^[\w$]+(\s*\?\?\s*[\w$]+)*$/.test(expr)) return ['<inline>'];
  const ids = expr.split('??').map((s) => s.trim());
  const cards = ids.filter((id) => /^[A-Z]/.test(id));
  // A lowercase callback anywhere in the chain is opaque, so it is reported too.
  return cards.length === ids.length ? cards : [...cards, '<inline>'];
}

/** `file:Card` for every grid card that does not report impressions. */
export function findUntrackedFeedCards(tree: SourceTree, exempt = EXEMPT): string[] {
  const untracked = new Set<string>();
  for (const [file, raw] of tree) {
    if (!isGridCaller(file, raw)) continue;
    for (const expr of renderExpressions(stripComments(raw))) {
      for (const card of renderTargets(expr)) {
        const key = `${toKey(file)}:${card}`;
        if (key in exempt) continue;
        // An inline function must render a tracked card itself. A callback named
        // in lowercase is opaque here, so it needs an exemption.
        const tracked =
          card === '<inline>'
            ? /^\s*\(/.test(expr) && rendersTracked(file, expr, tree, 1)
            : (() => {
                const component = resolveComponent(file, card, tree);
                return !!component && isTracked(component, tree);
              })();
        if (!tracked) untracked.add(key);
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
    const live = new Set<string>();
    for (const [file, source] of realTree()) {
      if (!isGridCaller(file, source)) continue;
      for (const expr of renderExpressions(stripComments(source)))
        for (const card of renderTargets(expr)) live.add(`${toKey(file)}:${card}`);
    }
    expect(Object.keys(EXEMPT).filter((key) => !live.has(key))).toEqual([]);
  });

  // Feed cards outside a grid's render prop, which the scan above cannot reach.
  // Each is checked in its OWN body: a sibling component's marker in the same
  // file does not count.
  test.each([
    ['components/Image/Infinite/ImagesCard.tsx', 'ImagesCardContent'],
    ['components/Image/AsPosts/ImagesAsPostsCard.tsx', 'ImagesAsPostsCardNoMemo'],
    ['components/Image/AsPosts/ImagesAsPostsCard.tsx', 'PostCarouselSlide'],
    ['components/Post/Infinite/PostsCard.tsx', 'PostsCard'],
    ['components/CreatorShop/Storefront/ModelShopCard.tsx', 'ModelShopCard'],
    ['components/Model/ModelCarousel/ModelCarousel.tsx', 'ModelCarouselContent'],
    ['pages/ecosystems/[key]/index.tsx', 'ResourceCard'],
    ['pages/ecosystems/[key]/index.tsx', 'default'],
    ['components/CardTemplates/AspectRatioImageCard.tsx', 'AspectRatioImageCard'],
    ['components/CardTemplates/AspectRatioCard.tsx', 'AspectRatioCard'],
    ['components/Cards/FeedCard.tsx', 'FeedCard'],
  ])('%s %s reports impressions itself', (path, name) => {
    expect(isTracked({ file: join(SRC, path), name }, new Map(), 0)).toBe(true);
  });

  // Their exemption says the shell records the cover image; hold them to it.
  test.each([
    ['components/Cards/ChallengeCard.tsx', 'ChallengeCard'],
    ['components/Cards/ComicCard.tsx', 'ComicCard'],
    ['components/Cards/CrucibleCard.tsx', 'CrucibleCard'],
  ])('%s still hands its cover image to AspectRatioImageCard', (path, name) => {
    const body = componentBody({ file: join(SRC, path), name }, new Map()) ?? '';
    expect(body).toMatch(/<AspectRatioImageCard\b[^>]*?\bimage=\{(?!\s*(undefined|null)\s*\})/);
  });

  test('AspectRatioImageCard turns the image it renders into an Image impression', () => {
    // The cover-image exemptions above rest on this.
    const body =
      componentBody(
        {
          file: join(SRC, 'components/CardTemplates/AspectRatioImageCard.tsx'),
          name: 'AspectRatioImageCard',
        },
        new Map()
      ) ?? '';
    expect(body).toMatch(/image\s*\?\s*\[\s*\{\s*entityType:\s*'Image'[^}]*entityId:\s*image\.id/);
  });

  test('ElementInView forwards `impressions` to useTrackImpression', () => {
    const source = read(join(SRC, 'components/IntersectionObserver/ElementInView.tsx'), new Map());
    expect(source).toMatch(/useTrackImpression\b[^;]*\(\s*impressions\s*\)/);
    expect(source).toMatch(/useMergedRef\([^)]*impressionRef/);
  });
});

describe('the guard can fail', () => {
  const card = (body: string, imports = '') =>
    `${imports}export function Card() { return ${body}; }\n`;
  const grid = (render: string) =>
    `import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';\n` +
    `import { Card } from './Card';\n` +
    `export function Feed() { return <MasonryColumns render={${render}} />; }\n`;
  const fixture = (cardSource: string, render = 'Card') =>
    new Map([
      [join(SRC, 'fixture/Feed.tsx'), grid(render)],
      [join(SRC, 'fixture/Card.tsx'), cardSource],
    ]);
  const untracked = (cardSource: string, render?: string) =>
    findUntrackedFeedCards(fixture(cardSource, render), {});
  const tracking = `<div ref={useTrackImpression([{ entityType: 'Image', entityId: 1 }])} />`;

  test('an untracked card in a feed is reported by name', () => {
    expect(untracked(card('<div />'))).toEqual(['fixture/Feed.tsx:Card']);
  });

  test('a card that tracks directly passes', () => {
    expect(untracked(card(tracking))).toEqual([]);
  });

  test('a hook whose ref is never attached is not tracking', () => {
    const source = `export function Card() { const ref = useTrackImpression([x]); return <div />; }\n`;
    expect(untracked(source)).toEqual(['fixture/Feed.tsx:Card']);
  });

  test('a card that renders a tracked component passes, one level down', () => {
    const source = card('<Inner />') + `function Inner() { return ${tracking}; }\n`;
    expect(untracked(source)).toEqual([]);
  });

  test("a sibling component's tracking does not vouch for the card", () => {
    const source = card('<div />') + `function Other() { return ${tracking}; }\n`;
    expect(untracked(source)).toEqual(['fixture/Feed.tsx:Card']);
  });

  test.each([
    ['ElementInView', '~/components/IntersectionObserver/ElementInView', '<ElementInView />'],
    [
      'AspectRatioImageCard',
      '~/components/CardTemplates/AspectRatioImageCard',
      '<AspectRatioImageCard image={x} />',
    ],
  ])('rendering %s without passing impressions is not coverage', (name, from, jsx) => {
    expect(untracked(card(jsx, `import { ${name} } from '${from}';\n`))).toEqual([
      'fixture/Feed.tsx:Card',
    ]);
  });

  test.each(['impressions={[]}', 'impressions={undefined}'])(
    '`%s` records nothing, so it is not a marker',
    (prop) => {
      expect(untracked(card(`<ElementInView ${prop} />`))).toEqual(['fixture/Feed.tsx:Card']);
    }
  );

  test('a marker inside a comment is not a marker', () => {
    expect(untracked(card('/* useTrackImpression([x]) */ <div />'))).toEqual([
      'fixture/Feed.tsx:Card',
    ]);
  });

  test('an inline render function that renders an untracked card is reported', () => {
    expect(untracked(card('<div />'), '(p) => <Card {...p} />')).toEqual([
      'fixture/Feed.tsx:<inline>',
    ]);
  });

  test.each(['renderItem', 'renderItem ?? Card'])(
    'a lowercase render callback is opaque, so `%s` is reported',
    (render) => {
      expect(untracked(card(tracking), render)).toEqual(['fixture/Feed.tsx:<inline>']);
    }
  );
});
