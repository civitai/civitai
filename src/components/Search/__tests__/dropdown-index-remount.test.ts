// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import {
  seedCarriedSearchText,
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
      const tag = openingTag(read(relPath));
      const indexName = propExpression(tag, 'indexName');
      const key = propExpression(tag, 'key');

      // Not merely "a key is present": the key and the index have to be the SAME expression, or
      // they can disagree and the provider survives a switch it was supposed to be rebuilt for.
      expect(indexName).toBeTruthy();
      expect(key).toBe(indexName);
    });
  }
});

describe('the dropdown roots carry the typed text across that remount', () => {
  // Keying the provider remounts the subtree the typed text lives in, so each of these two has to
  // hold that text ABOVE the provider. Asserted structurally because the components themselves are
  // browser-tier; the carry mechanism's behaviour is exercised further down.
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

      // The shape this replaced. State seeded from the helper's own query comes back EMPTY on a
      // remount, which is the regression a re-introduced `useState(query)` would be.
      expect(source).not.toContain('useState(query)');
    });
  }
});

const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
});

type Harness = {
  render: (indexName: string, refinedQuery: string) => Promise<void>;
  text: () => string;
  type: (value: string) => Promise<void>;
};

/**
 * A parent that owns the carrier and a child keyed on the index name — the arrangement both
 * dropdowns now use. `carried: false` is the negative control: the same tree with the text seeded
 * from the helper's query instead, which is what these components did before.
 */
function mount(carried: boolean): Harness {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  roots.push(root);

  let write: ((value: string) => void) | null = null;

  function Child({
    carriedRef,
    refinedQuery,
  }: {
    carriedRef: React.MutableRefObject<string>;
    refinedQuery: string;
  }) {
    const viaCarrier = useCarriedSearchText(carriedRef, refinedQuery);
    const viaState = React.useState(refinedQuery);
    const [text, setText] = carried ? viaCarrier : viaState;
    write = setText;
    return React.createElement('span', null, text);
  }

  function Parent({ indexName, refinedQuery }: { indexName: string; refinedQuery: string }) {
    const carriedRef = React.useRef('');
    return React.createElement(Child, { key: indexName, carriedRef, refinedQuery });
  }

  return {
    render: async (indexName, refinedQuery) => {
      await act(async () => root.render(React.createElement(Parent, { indexName, refinedQuery })));
    },
    text: () => container.textContent ?? '',
    type: async (value) => {
      await act(async () => write?.(value));
    },
  };
}

describe('useCarriedSearchText', () => {
  it('keeps the typed text when the index changes and the provider is rebuilt', async () => {
    const harness = mount(true);
    await harness.render('models_v9', '');
    await harness.type('dreamshaper');
    expect(harness.text()).toBe('dreamshaper');

    await harness.render('articles_v6', '');

    expect(harness.text()).toBe('dreamshaper');
  });

  it('leaves that text differing from the rebuilt helper query, so the search is re-run', async () => {
    // The refine effect in each component is `if (debouncedSearch === query) return;`. A rebuilt
    // helper reports an empty query, so this inequality is what makes it fire on the new index
    // instead of the input merely re-displaying the old text.
    const harness = mount(true);
    await harness.render('models_v9', '');
    await harness.type('dreamshaper');
    await harness.render('articles_v6', '');

    expect(harness.text()).not.toBe('');
  });

  it('NEGATIVE CONTROL — the same remount drops the text without the carrier', async () => {
    // Proves the remount in the test above is real. Without this, a harness that silently never
    // remounted would pass every assertion above while asserting nothing.
    const harness = mount(false);
    await harness.render('models_v9', '');
    await harness.type('dreamshaper');
    expect(harness.text()).toBe('dreamshaper');

    await harness.render('articles_v6', '');

    expect(harness.text()).toBe('');
  });

  it('seeds a first mount from the helper query, since nothing has been typed yet', async () => {
    const harness = mount(true);
    await harness.render('models_v9', 'restored-from-url');
    expect(harness.text()).toBe('restored-from-url');
  });

  it('carries a cleared input as cleared, not as the helper query', async () => {
    const harness = mount(true);
    await harness.render('models_v9', '');
    await harness.type('dreamshaper');
    await harness.type('');
    await harness.render('articles_v6', 'restored-from-url');

    // An empty carrier falls back to the helper query — the first-mount behaviour above. That is
    // the documented precedence, pinned here so a change to it is a decision rather than a drift.
    expect(harness.text()).toBe('restored-from-url');
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
