// @vitest-environment happy-dom
import type { Dirent } from 'fs';
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
 * Drop comments before any check that COUNTS or LOCATES a token. Prose naming the token satisfies
 * it otherwise — including, in this file's case, prose written to warn against the mutation the
 * count exists to catch. Whole-line `//` only, plus block comments, so a `//` inside a string
 * literal cannot blind the scan.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The selector's value, in full. The predicate alone says WHICH list is consulted; the two
 * branches say what is done with the answer, and both are load-bearing — negating the condition
 * shows the target only when it is NOT offered, and replacing the `null` with a first-option
 * fallback reinstates the wrong-label lie the clamp exists to prevent. Neither is visible to a
 * check on the `.some(…)` call.
 *
 * ⚠️ Spelling-pinned, and measured at EXACTLY 100 characters in both files against
 * `printWidth: 100`. A rename of `indexNameProp`/`enabledTargets`, or one more level of
 * indentation, makes prettier break the expression across lines and this goes red for a pure
 * formatting change. Re-pin the new spelling; do not loosen it back to the predicate alone.
 */
const SELECTOR_VALUE_CLAMP =
  'value={enabledTargets.some(({ value }) => value === indexNameProp) ? indexNameProp : null}';

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

/**
 * Every non-test `.tsx` under `src/` that renders an `<InstantSearch>` element, repo-relative.
 *
 * A full-suite run creates and removes directories under `src/` while this walk is happening, so
 * an entry can vanish between the listing and the read. Its sibling ledger in this directory
 * documents that as an OBSERVED hazard — it surfaces as a collection failure, which contributes
 * zero tests and moves no failure count — so entries that cannot be read are skipped rather than
 * thrown on.
 */
function findInstantSearchRoots(dir = 'src'): string[] {
  const found: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(path.join(repoRoot, dir), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const relPath = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...findInstantSearchRoots(relPath));
    } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
      try {
        if (stripComments(read(relPath)).includes('<InstantSearch')) found.push(relPath);
      } catch {
        continue;
      }
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
 * The index a dropdown root passes must be DERIVED FROM ITS TARGET, not pinned to a constant —
 * pinning it leaves `key` and `indexName` still agreeing (so the ledger below still passes) while
 * the target selector stops switching index at all in production.
 *
 * Asserted on the declaration rather than on the JSX, because both dropdowns hoist the expression
 * into a local and a check on the tag then sees only an identifier. Stated as what a tracking
 * index IS — subscripted by `targetIndex` — rather than as a list of constant spellings to reject:
 * enumerating spellings caught `searchIndexMap.models` and a string literal while
 * `searchIndexMap['models']` and an imported `IMAGES_SEARCH_INDEX` walked straight through.
 *
 * Scoped to the two dropdowns on purpose. `SearchLayout` takes its index as a PROP — dynamic by
 * construction — and an earlier attempt to resolve identifiers generically bound its name to an
 * unrelated `const indexName = Object.keys(uiState)?.[0]` elsewhere in that file.
 */
const INDEX_TRACKS_TARGET = /const \w+ = searchIndexMap\[\s*targetIndex\b/;

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

      // That the index TRACKS the target — which this check cannot see, since both dropdowns pass
      // a hoisted identifier here — is asserted per dropdown below, via INDEX_TRACKS_TARGET.
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
      const source = stripComments(read(relPath));

      const carrierDeclaration = source.indexOf("const carriedSearchText = useRef('')");
      const provider = source.indexOf('<InstantSearch');
      expect(carrierDeclaration).toBeGreaterThan(-1);
      expect(provider).toBeGreaterThan(carrierDeclaration);

      expect(source).toContain('carriedSearchText={carriedSearchText}');

      // The hook's RESULT has to drive the input, not merely be called — declared here, and then
      // WIRED to the input below. Calling it and seeding from `useState(query)` beside it, or
      // leaving the declaration in place and rendering `value={query}`, each revert the whole
      // mechanism while a check on the call alone stays green.
      expect(source).toContain(
        'const [search, setSearch] = useCarriedSearchText(carriedSearchText, query)'
      );
      expect(source).toContain('value={search}');
      expect(source).toContain('setSearch(value)');

      // And the index the provider is keyed on tracks the target, rather than being pinned to a
      // constant that leaves key and index agreeing while the selector stops switching anything.
      expect(source).toMatch(INDEX_TRACKS_TARGET);
    });
  }

  it('both refine gates go through the one predicate, negation included', () => {
    // The leading `!` is the whole gate. Dropping it inverts both effects — they return early
    // exactly when they should refine — which kills the feature with every other assertion here
    // satisfied, because a check on the call expression alone cannot see the operator in front
    // of it. Pinned as the complete `if`, per component, since their blocked arguments differ.
    // `toMatch` on this one, not `toContain`: prettier wraps it across two lines, so the `return`
    // it guards has to be matched across the break — otherwise neutering the consequent leaves the
    // effect refining during an outage with the gate itself still spelled correctly.
    expect(stripComments(read('src/components/AutocompleteSearch/AutocompleteSearch.tsx'))).toMatch(
      /if \(!shouldRefineSearchQuery\(debouncedSearch, query, !!selectedItem \|\| searchErrorState\)\)\s*return;/
    );
    expect(stripComments(read('src/components/Search/QuickSearchDropdown.tsx'))).toContain(
      'if (!shouldRefineSearchQuery(debouncedSearch, query)) return;'
    );
  });

  it('AutocompleteSearch follows the URL section from ABOVE the keyed provider', () => {
    // MEASURED REGRESSION, not a hypothetical. This sync used to live inside the subtree with
    // `[searchTarget]` deps, and `searchTarget` comes from the pathname rather than from the pick.
    // A mount runs every effect, so once the provider is keyed, choosing a category remounts the
    // subtree, the effect sees the URL's section instead of the pick, and reverts it — the header
    // category selector then only ever "works" when it picks what the URL already said.
    //
    // Comments stripped: every check below counts or locates a token, and prose naming the token
    // — including prose warning against the very mutation being counted — would satisfy it.
    const source = stripComments(read('src/components/AutocompleteSearch/AutocompleteSearch.tsx'));

    const sync = source.indexOf('setTargetIndex(searchTarget)');
    const provider = source.indexOf('<InstantSearch');
    expect(sync).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(sync);

    // EXACTLY ONE writer. Hoisting the sync while leaving the old copy in place reintroduces the
    // whole defect with the assertion above still satisfied — the consolidation-that-forgot-to-
    // delete shape, which is the likeliest way this comes back.
    expect([...source.matchAll(/(?:setTargetIndex|onTargetChange)\(searchTarget/g)]).toHaveLength(
      1
    );

    // …and it still FOLLOWS navigation. Emptying its dependency array leaves one writer, in the
    // right place, that only ever runs once. The array only has to CONTAIN `searchTarget` —
    // requiring it to be exactly `[searchTarget]` would go red on a legitimate added dependency.
    expect(source.slice(sync)).toMatch(
      /^\s*setTargetIndex\(searchTarget\);[^[\]]{0,300}?\}, \[[^\]]*\bsearchTarget\b[^\]]*\]\)/
    );

    // …and the selector reads the target rather than holding its own copy of it, which a remount
    // would reset while the search really had moved.
    expect(source).toContain(SELECTOR_VALUE_CLAMP);
    expect(source).toContain('data={enabledTargets}');
    expect(source).not.toContain('defaultValue={searchTarget}');

    // INVARIANT GUARD, not regression coverage: this prop predates the PR here. It is load-bearing
    // all the same — this change handler casts away the `null` a deselect produces, and unlike the
    // sibling it has no fallback, so `searchIndexMap[null]` would reach the provider as an
    // undefined index. It is the unguarded copy that a "these two selectors duplicate props"
    // tidy-up would delete.
    expect(source).toContain('allowDeselect={false}');
  });

  it('QuickSearchDropdown drives its index selector from the target it is searching', () => {
    const source = stripComments(read('src/components/Search/QuickSearchDropdown.tsx'));

    expect(source).toContain(SELECTOR_VALUE_CLAMP);
    expect(source).toContain('data={enabledTargets}');
    expect(source).not.toContain('defaultValue={availableIndexes[0]}');

    // A single-option selector is deselectable by default, and the `null` that produces would
    // move the target off the set the caller supports — for one caller, into a payout path.
    expect(source).toContain('allowDeselect={false}');

    // DELIBERATELY UNCOVERED, said out loud rather than left as a silent omission: the
    // `startingIndex ?? supportedIndexes[0] ?? 'models'` fallback is a forward guard. No caller
    // reaches it today (the assertion above closes the only path that could), so reverting it to
    // a bare `'models'` leaves this suite green, and a test for it would be an invariant guard.
  });

  it('AutocompleteSearch re-runs its refine effect when search availability recovers', () => {
    // `searchErrorState` reads a module-level store, so it is the one input to that effect which
    // SURVIVES the remount. Missing from the deps, a tree that remounted while search was
    // unavailable restores the typed text, returns early, and never refines once the flag clears
    // — a populated box over an empty helper query. Pinned structurally because only a render of
    // the real component could observe it, and that is the browser tier.
    // Comments stripped first: a dependency array can otherwise satisfy a token search with the
    // token sitting inside `/* … */`, which is the walk `openingTag` above already guards against.
    const source = stripComments(read('src/components/AutocompleteSearch/AutocompleteSearch.tsx'));
    const deps = source.match(/\}, \[debouncedSearch, query, indexName[^\]]*\]/);

    expect(deps?.[0] ?? '(no refine dependency array matched)').toContain('searchErrorState');

    // The other half — that the flag is still PASSED to the predicate, which a dependency array
    // cannot see — is pinned by the refine-gate test above, whose full `if (…)` expression
    // subsumes it. Deliberately not restated here; one change should redden one test.
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

  it('INVARIANT: carried text outranks a non-empty helper query at the hook, not just in the helper', async () => {
    // Both non-empty at once cannot happen in production — a rebuilt helper always reports `''` —
    // so this pins a property the bug never violated rather than covering a regression. It earns
    // its place by being the only thing that can see the hook's own call into
    // `seedCarriedSearchText` with its arguments SWAPPED: every other case has one of the two
    // empty, which makes the swap indistinguishable from the correct order.
    const harness = mount(true);
    await harness.render('models_v9');
    await harness.type('dreamshaper');

    await harness.render('articles_v6', { helperQuery: 'restored-from-url' });

    expect(harness.text()).toBe('dreamshaper');
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
