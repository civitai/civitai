// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  seedCarriedSearchText,
  shouldRefineSearchQuery,
  useCarriedSearchText,
} from '~/components/Search/useCarriedSearchText';

// React 18.3 exposes `act` on the `react` export, but our @types/react (18.0.x) predates that
// typing. Use the runtime `React.act` and borrow the signature from react-dom/test-utils — the
// same arrangement the other node-tier React tests in this repo use.
const act = (React as unknown as { act: typeof actType }).act;

const repoRoot = path.resolve(__dirname, '../../../..');
const read = (relPath: string) => readFileSync(path.join(repoRoot, relPath), 'utf8');

/**
 * Every `<InstantSearch>` root in the app, and what each is required to do about the index it
 * targets. `keyed` roots take a target the user can change at runtime: react-instantsearch-core
 * calls `helper.setIndex(indexName).search()` in its RENDER body, and the provider renders before
 * the children that own `filters`, so a target switch on an unkeyed root searches the NEW index
 * with the PREVIOUS target's parameters. `key` makes React build a fresh provider instead.
 *
 * The ledger is exhaustive on purpose: a new root added without a decision fails this rather than
 * inheriting a default.
 */
const INSTANT_SEARCH_ROOTS = {
  'src/components/Search/SearchLayout.tsx': 'keyed',
  'src/components/AutocompleteSearch/AutocompleteSearch.tsx': 'keyed',
  'src/components/Search/QuickSearchDropdown.tsx': 'keyed',
  // Exempt, and the reason is asserted below rather than taken on trust: its index is a fixed
  // member of `searchIndexMap`, so there is no switch for a stale parameter set to survive.
  'src/components/CollectionSelectModal/CollectionSelectModal.tsx': 'static-index',
} as const;

/** Every non-test `.tsx` under `src/` that renders an `<InstantSearch>` element, repo-relative. */
function findInstantSearchRoots(dir = 'src'): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const relPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...findInstantSearchRoots(relPath));
    } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
      if (read(relPath).includes('<InstantSearch')) found.push(relPath);
    }
  }
  return found;
}

/** The opening `<InstantSearch …>` tag, with `//` comments stripped so prose can't satisfy a prop match. */
function openingTag(source: string): string {
  // The ELEMENT, not a mention of it: prose naming the tag matches the same pattern, so the tag is
  // identified by the prop every root must pass rather than by its name alone.
  const tags = [...source.matchAll(/<InstantSearch\b[^>]*>/g)]
    .map((m) => m[0].replace(/^\s*\/\/.*$/gm, ''))
    .filter((tag) => /\ssearchClient=\{/.test(tag));
  if (tags.length !== 1)
    throw new Error(`expected one <InstantSearch> element, found ${tags.length}`);
  return tags[0];
}

function propExpression(tag: string, prop: string): string | null {
  const match = tag.match(new RegExp(`(?:^|\\s)${prop}=\\{([^}]*)\\}`));
  return match ? match[1].trim() : null;
}

/**
 * Follow a bare identifier to its local `const` initializer, so the checks below see what the
 * index really IS rather than what it is spelled. A root that hoists the expression into a local
 * (both dropdowns do) would otherwise satisfy any check on the tag no matter what the local held
 * — a `const x = searchIndexMap.models` mutant survives the whole file without this.
 *
 * An identifier with no local `const` is a prop or a piece of state (`SearchLayout`'s `indexName`
 * is a prop), which is dynamic by construction; it is returned unchanged and passes.
 */
function resolveIndexExpression(source: string, expression: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return expression;
  const declaration = source.match(new RegExp(`\\bconst ${expression}\\s*=\\s*([^;\\n]+)`));
  return declaration ? declaration[1].trim() : expression;
}

describe('the InstantSearch roots', () => {
  it('is the set this ledger accounts for', () => {
    // Derived from the tree, so the ledger fails when the population grows OR shrinks — a new
    // root cannot be added without deciding what it does about a changing index.
    expect(findInstantSearchRoots().sort()).toEqual(Object.keys(INSTANT_SEARCH_ROOTS).sort());
  });

  for (const [relPath, policy] of Object.entries(INSTANT_SEARCH_ROOTS)) {
    if (policy === 'static-index') {
      it(`${relPath} targets a fixed index, so it needs no key`, () => {
        const tag = openingTag(read(relPath));
        expect(propExpression(tag, 'indexName')).toMatch(/^searchIndexMap\.[A-Za-z]+$/);
        expect(propExpression(tag, 'key')).toBeNull();
      });
      continue;
    }

    it(`${relPath} keys its provider on the very expression it passes as indexName`, () => {
      const source = read(relPath);
      const tag = openingTag(source);
      const indexName = propExpression(tag, 'indexName');
      const key = propExpression(tag, 'key');

      // Not merely "a key is present": the key and the index have to be the SAME expression, or
      // they can disagree and the provider survives a switch it was supposed to be rebuilt for.
      expect(indexName).toBeTruthy();
      expect(key).toBe(indexName);

      // And the index has to TRACK something — the inverse of the `static-index` branch's check,
      // so the two policies are mutually exclusive. Without it, pinning the index to one constant
      // leaves key and index still agreeing while the target selector stops switching index at
      // all in production, and every assertion above stays green.
      const resolved = resolveIndexExpression(source, indexName as string);
      expect(resolved).not.toMatch(/^searchIndexMap\.[A-Za-z]+$/);
      expect(resolved).not.toMatch(/^['"`]/);
    });
  }
});

describe('the dropdown roots carry the typed text across that remount', () => {
  // Keying the provider remounts the subtree the typed text lives in, so each of these two has to
  // hold that text ABOVE the provider. These are SPELLING-AND-FILE-ORDER checks, not tree-position
  // ones: they pin that the declaration is written before the provider in the same file and that
  // the ref is threaded and read by name. A rename, or moving the content component above the
  // provider in the file, breaks them for a non-defect. They are the only coverage available here
  // — the components are browser-tier, and the node project collects `.test.ts` only. The carry
  // MECHANISM's behaviour is exercised further down, against a real remount.
  const dropdowns = [
    'src/components/AutocompleteSearch/AutocompleteSearch.tsx',
    'src/components/Search/QuickSearchDropdown.tsx',
  ];

  for (const relPath of dropdowns) {
    it(`${relPath} holds the text above the keyed boundary and seeds the input from it`, () => {
      const source = read(relPath);

      const carrierDeclaration = source.indexOf("const carriedSearchText = useRef('')");
      const provider = source.indexOf('<InstantSearch');
      expect(carrierDeclaration).toBeGreaterThan(-1);
      expect(provider).toBeGreaterThan(carrierDeclaration);

      expect(source).toContain('carriedSearchText={carriedSearchText}');
      expect(source).toContain('useCarriedSearchText(carriedSearchText, query)');

      // Both refine decisions go through the one predicate, so there is a single place where
      // "does this tree still owe its text to the helper" is decided.
      expect(source).toContain('shouldRefineSearchQuery(');
    });
  }

  it('AutocompleteSearch follows the URL section from ABOVE the keyed provider', () => {
    // MEASURED REGRESSION, not a hypothetical. This sync used to live inside the subtree with
    // `[searchTarget]` deps, and `searchTarget` comes from the pathname rather than from the pick.
    // A mount runs every effect, so once the provider is keyed, choosing a category remounts the
    // subtree, the effect sees the URL's section instead of the pick, and reverts it — the header
    // category selector then only ever "works" when it picks what the URL already said.
    const source = read('src/components/AutocompleteSearch/AutocompleteSearch.tsx');

    const sync = source.indexOf('setTargetIndex(searchTarget)');
    const provider = source.indexOf('<InstantSearch');
    expect(sync).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(sync);

    // …and the selector reads the target rather than holding its own copy of it, which a remount
    // would reset while the search really had moved.
    expect(source).toContain('value={indexNameProp}');
    expect(source).not.toContain('defaultValue={searchTarget}');
  });

  it('QuickSearchDropdown drives its index selector from the target it is searching', () => {
    const source = read('src/components/Search/QuickSearchDropdown.tsx');

    expect(source).toContain('value={indexNameProp}');
    expect(source).not.toContain('defaultValue={availableIndexes[0]}');
  });

  it('AutocompleteSearch re-runs its refine effect when search availability recovers', () => {
    // `searchErrorState` reads a module-level store, so it is the one input to that effect which
    // SURVIVES the remount. Missing from the deps, a tree that remounted while search was
    // unavailable restores the typed text, returns early, and never refines once the flag clears
    // — a populated box over an empty helper query. Pinned structurally because only a render of
    // the real component could observe it, and that is the browser tier.
    const source = read('src/components/AutocompleteSearch/AutocompleteSearch.tsx');
    const deps = source.match(/\}, \[debouncedSearch, query, indexName[^\]]*\]/);

    expect(deps?.[0]).toContain('searchErrorState');
  });
});

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
});

type Harness = {
  render: (
    indexName: string,
    options?: { helperQuery?: string; blocked?: boolean }
  ) => Promise<void>;
  text: () => string;
  type: (value: string) => Promise<void>;
  refinedWith: () => string[];
};

/**
 * The arrangement both dropdowns now use, with the search helper modelled by the smallest thing
 * that can be wrong about it: per-mount state that a remount resets to its initial value, plus the
 * components' own refine effect — the REAL `shouldRefineSearchQuery`, not a restatement of it.
 *
 * `carried: false` is the negative control: the same tree with the text seeded from the helper's
 * query instead, which is what these components did before.
 */
function mount(carried: boolean): Harness {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  roots.push(root);

  let write: ((value: string) => void) | null = null;
  const refined: string[] = [];

  function Child({
    carriedRef,
    helperQuery,
    blocked,
  }: {
    carriedRef: React.MutableRefObject<string>;
    helperQuery: string;
    blocked: boolean;
  }) {
    const viaCarrier = useCarriedSearchText(carriedRef, helperQuery);
    const viaState = React.useState(helperQuery);
    const [text, setText] = carried ? viaCarrier : viaState;
    write = setText;

    // The helper's own query. Per-mount, so a keyed remount hands the child a rebuilt helper
    // reporting whatever it was constructed with — `''` in production.
    const [refinedQuery, setRefinedQuery] = React.useState(helperQuery);
    React.useEffect(() => {
      if (!shouldRefineSearchQuery(text, refinedQuery, blocked)) return;
      refined.push(text);
      setRefinedQuery(text);
    }, [text, refinedQuery, blocked]);

    return React.createElement('span', null, text);
  }

  function Parent({
    indexName,
    helperQuery,
    blocked,
  }: {
    indexName: string;
    helperQuery: string;
    blocked: boolean;
  }) {
    const carriedRef = React.useRef('');
    return React.createElement(Child, { key: indexName, carriedRef, helperQuery, blocked });
  }

  return {
    render: async (indexName, { helperQuery = '', blocked = false } = {}) => {
      await act(async () =>
        root.render(React.createElement(Parent, { indexName, helperQuery, blocked }))
      );
    },
    text: () => container.textContent ?? '',
    type: async (value) => {
      await act(async () => write?.(value));
    },
    refinedWith: () => [...refined],
  };
}

describe('useCarriedSearchText', () => {
  it('keeps the typed text when the index changes and the provider is rebuilt', async () => {
    const harness = mount(true);
    await harness.render('models_v9');
    await harness.type('dreamshaper');
    expect(harness.text()).toBe('dreamshaper');

    await harness.render('articles_v6');

    expect(harness.text()).toBe('dreamshaper');
  });

  it('pushes that text into the rebuilt helper, so the search runs again on the new index', async () => {
    // The point of the seed. A rebuilt helper reports an empty query, so the carried text differs
    // from it and the refine effect fires a SECOND time — the search is re-run rather than the
    // input merely re-displaying the old text.
    const harness = mount(true);
    await harness.render('models_v9');
    await harness.type('dreamshaper');
    expect(harness.refinedWith()).toEqual(['dreamshaper']);

    await harness.render('articles_v6');

    expect(harness.refinedWith()).toEqual(['dreamshaper', 'dreamshaper']);
  });

  it('NEGATIVE CONTROL — the same remount drops the text, and refines nothing, without the carrier', async () => {
    // Proves the remount in the tests above is real: without it `viaState` would still hold the
    // text and this would fail. Read it together with the two tests above — this one shows the
    // CHILD was rebuilt, and those show the parent's ref survived that rebuild. Neither claim
    // stands alone.
    const harness = mount(false);
    await harness.render('models_v9');
    await harness.type('dreamshaper');
    expect(harness.text()).toBe('dreamshaper');

    await harness.render('articles_v6');

    expect(harness.text()).toBe('');
    expect(harness.refinedWith()).toEqual(['dreamshaper']);
  });

  it('does not refine while search is unavailable, and refines once it recovers', async () => {
    // `blocked` stands for `searchErrorState`, which reads a module-level store and therefore
    // SURVIVES the remount. It has to be an input the effect can re-run on: a tree that remounted
    // while blocked restores the text, refines nothing, and would otherwise sit on a populated
    // input over an empty helper query until the next keystroke.
    const harness = mount(true);
    await harness.render('models_v9');
    await harness.type('dreamshaper');
    await harness.render('articles_v6', { blocked: true });
    expect(harness.text()).toBe('dreamshaper');
    expect(harness.refinedWith()).toEqual(['dreamshaper']);

    await harness.render('articles_v6', { blocked: false });

    expect(harness.refinedWith()).toEqual(['dreamshaper', 'dreamshaper']);
  });

  it('seeds a first mount from the helper query, since nothing has been typed yet', async () => {
    const harness = mount(true);
    await harness.render('models_v9', { helperQuery: 'restored-from-url' });
    expect(harness.text()).toBe('restored-from-url');
  });

  it('gives each carrier its own text — two search surfaces on one page do not share', async () => {
    // A module-scope slot instead of the passed ref would pass every test above while making the
    // header search and a dropdown on the same page overwrite each other.
    const typedInto = mount(true);
    const untouched = mount(true);
    await typedInto.render('models_v9');
    await untouched.render('models_v9');

    await typedInto.type('dreamshaper');
    await untouched.render('articles_v6');

    expect(untouched.text()).toBe('');
  });

  it('an emptied input falls back to the helper query on the next mount', async () => {
    const harness = mount(true);
    await harness.render('models_v9');
    await harness.type('dreamshaper');
    await harness.type('');
    await harness.render('articles_v6', { helperQuery: 'restored-from-url' });

    // An empty carrier falls back to the helper query — the first-mount behaviour above. That is
    // the documented precedence, pinned here so a change to it is a decision rather than a drift.
    expect(harness.text()).toBe('restored-from-url');
  });
});

describe('shouldRefineSearchQuery', () => {
  it('refines when the typed text differs from the helper query', () => {
    expect(shouldRefineSearchQuery('dreamshaper', '')).toBe(true);
  });

  it('does not refine when the helper already holds that text', () => {
    expect(shouldRefineSearchQuery('dreamshaper', 'dreamshaper')).toBe(false);
  });

  it('does not refine while blocked, however far apart the two are', () => {
    expect(shouldRefineSearchQuery('dreamshaper', '', true)).toBe(false);
  });
});

describe('seedCarriedSearchText', () => {
  it('prefers carried text over the helper query', () => {
    expect(seedCarriedSearchText('dreamshaper', 'restored-from-url')).toBe('dreamshaper');
  });

  it('falls back to the helper query when nothing is carried', () => {
    expect(seedCarriedSearchText('', 'restored-from-url')).toBe('restored-from-url');
    expect(seedCarriedSearchText(undefined, 'restored-from-url')).toBe('restored-from-url');
  });
});
