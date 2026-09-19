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
 * Compared with `containsIgnoringWhitespace`, never `toContain`. This is one expression against
 * `printWidth: 100`, and it has already sat at EXACTLY 100 characters once: a rename, or one more
 * level of indentation, makes prettier re-wrap it and a literal check then goes red about a clamp
 * that is still correct. Only the whitespace is forgiven — every identifier, operator and branch
 * still has to be there, in order. Re-pin a renamed spelling; do not loosen it to the predicate.
 */
const SELECTOR_VALUE_CLAMP =
  'value={enabledTargets.some(({ value }) => value === targetIndex) ? targetIndex : null}';

/**
 * Containment with every whitespace character removed from BOTH sides. Prettier breaks a long JSX
 * attribute inside its own braces as well as between attributes, so collapsing runs to a single
 * space does not survive a wrap — removing whitespace entirely does. What that gives up is real,
 * but does not reach THIS needle: with whitespace stripped from both sides, sources differing only
 * inside a string literal compare equal, and a needle whose tokens are separated only by a space
 * matches a source that has run them together. `SELECTOR_VALUE_CLAMP` contains no string literal,
 * and every adjacency in it is punctuated rather than whitespace-separated, so neither applies.
 * Do not reuse this for a needle that does contain a literal.
 */
const containsIgnoringWhitespace = (source: string, needle: string) =>
  source.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));

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
 * an entry can vanish between the listing and the read. That is an OBSERVED hazard, not a
 * hypothetical one, and it surfaces as a COLLECTION failure — which contributes zero tests and
 * moves no failure count, so it reads as "nothing to see". Entries that cannot be read are
 * therefore skipped rather than thrown on.
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

/** The opening `<InstantSearch …>` tag. Callers pass `stripComments`ed source. */
function openingTag(source: string): string {
  // The ELEMENT, not a mention of it: prose naming the tag matches the same pattern, so the tag is
  // identified by the prop every root must pass rather than by its name alone.
  const tags = [...source.matchAll(/<InstantSearch\b[^>]*>/g)]
    .map((m) => m[0])
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
 * Stated as what a tracking index IS — subscripted by `targetIndex` — rather than as a list of
 * constant spellings to reject: enumerating spellings caught `searchIndexMap.models` and a string
 * literal while `searchIndexMap['models']` and an imported `IMAGES_SEARCH_INDEX` walked straight
 * through. Matched against the EXPRESSION, so it holds whether that expression is written inline
 * on the provider or hoisted into a local first. Anchored, so it also rejects a WRAPPED form such
 * as `useMemo(() => searchIndexMap[targetIndex], …)` — correct code, declined rather than
 * accommodated: memoising a hash lookup is not worth widening a guard for, and the failure is
 * legible if anyone ever does it.
 *
 * Scoped to the two dropdowns on purpose. `SearchLayout` takes its index as a PROP — dynamic by
 * construction — and an earlier attempt to resolve identifiers generically bound its name to an
 * unrelated `const indexName = Object.keys(uiState)?.[0]` elsewhere in that file.
 */
const INDEX_TRACKS_TARGET_EXPRESSION = /^searchIndexMap\[\s*targetIndex\b/;

/**
 * The category `<Select>` element's source, delimited by the provider that follows it. Both
 * dropdowns render the selector immediately above `<InstantSearch>` — the file-order check below
 * is what keeps that true — and a brace-counting parse is not worth writing for it: over-reading
 * to the provider can only make a `not.toMatch` on this region WIDER, never blinder.
 */
function selectorSource(source: string): string {
  const selector = source.indexOf('<Select');
  const provider = source.indexOf('<InstantSearch');
  if (selector < 0 || provider < selector)
    throw new Error('expected a <Select> written above <InstantSearch>');
  return source.slice(selector, provider);
}

/**
 * The expression a provider receives, resolved one hop when it is a hoisted local `const` — which
 * is how the dropdowns write it. Both the inline and the hoisted form are correct code, so a check
 * that reads only one of them rejects the other; this is what lets the callers assert the SHAPE
 * without also dictating where it is written.
 *
 * Only ever called with a bare identifier (the caller tests for that), so nothing here needs
 * regex-escaping. The optional `:type` tolerates an annotated declaration.
 */
function resolveOneHop(source: string, expression: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return expression;
  const declaration = source.match(new RegExp(`const ${expression}\\s*(?::[^=]+)?=\\s*([^;\\n]+)`));
  return declaration?.[1].trim() ?? expression;
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
        const tag = openingTag(stripComments(read(relPath)));
        expect(propExpression(tag, 'indexName')).toMatch(/^searchIndexMap\.[A-Za-z]+$/);
        expect(propExpression(tag, 'key')).toBeNull();
      });
      continue;
    }

    it(`${relPath} keys its provider on the very expression it passes as indexName`, () => {
      const source = stripComments(read(relPath));
      const tag = openingTag(source);
      const indexName = propExpression(tag, 'indexName');
      const key = propExpression(tag, 'key');

      // Not merely "a key is present": the key and the index have to be the SAME expression, or
      // they can disagree and the provider survives a switch it was supposed to be rebuilt for.
      expect(indexName).toBeTruthy();
      expect(key).toBe(indexName);

      // 🔴 THERE IS DELIBERATELY NOTHING MORE HERE FOR `SearchLayout`, AND THAT IS A DECISION.
      // Four review rounds were spent on a guard requiring its index expression to reference the
      // prop, each round's fix producing the next round's finding: it passed broken code twice
      // (an imported constant; a shadowing local behind a comment) and rejected correct code three
      // times (a normalisation hop, the `export const` style, a reordered destructuring), and the
      // last version lost a kill while adding brittleness. It was a regex approximation of scope
      // resolution, and it never reached a fixed point.
      //
      // The requirement did not survive being questioned: `SearchLayout` is not touched by the
      // change this file was written for, so that guard protected an invariant no commit here can
      // violate, at the cost of reddening ordinary refactors with a message that misdiagnosed them.
      // `key === indexName` above is order-, style- and alias-independent, and is the claim this
      // ledger exists to make. Do not add it back without a defect it would have caught.
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
      //
      // The third binding is optional because only one of the two takes it: `AutocompleteSearch`
      // needs the display-only clear for its blur handler, and `QuickSearchDropdown` has no blur
      // clear to give it to. Both spellings are correct; pinning one would reject the other.
      expect(source).toMatch(
        /const \[search, setSearch(?:, clearDisplayedText)?\] = useCarriedSearchText\(\s*carriedSearchText,\s*query\s*\)/
      );
      expect(source).toContain('value={search}');
      expect(source).toContain('setSearch(value)');
    });
  }

  it('both dropdowns derive the index they key on from the target', () => {
    // INVARIANT GUARD, not regression coverage — and it became one when the check learned to
    // accept the inline form: both roots already derived their index correctly at the PR base, so
    // this is green there. What the base lacked was the `key`, which the ledger above covers. This
    // exists because keying the provider makes a constant index silently survivable: `key` and
    // `indexName` would still agree while the selector stopped switching anything.
    //
    // Follows the expression the PROVIDER actually receives, then resolves it one hop if it is a
    // hoisted identifier — which is how both roots write it today. Both halves are needed and
    // neither is sufficient: checking only the declaration lets the JSX be pinned to a constant
    // while an unused tracking `const` sits above it, and checking only the JSX rejects the
    // equally correct inline form.
    for (const relPath of dropdowns) {
      const source = stripComments(read(relPath));
      const expression = propExpression(openingTag(source), 'indexName') ?? '';

      expect(resolveOneHop(source, expression), relPath).toMatch(INDEX_TRACKS_TARGET_EXPRESSION);
    }
  });

  it('picking a category reaches the state the index is derived from', () => {
    // The counterpart of the input wiring above, and the same hole one level up: the suite pins
    // the selector's value, its options and its deselect behaviour, but nothing pinned that
    // choosing an option arrives at `setTargetIndex`. Neutering either handler leaves manual
    // category switching dead while `AutocompleteSearch` still looks alive — its URL-follow effect
    // keeps calling `setTargetIndex` — and the exactly-one-writer count further down cannot see
    // it, because that count matches `setTargetIndex(searchTarget` while the selector's handler
    // writes `setTargetIndex(value)`.
    // ⚠️ Every assertion here except `setTargetIndex(value ?? fallbackIndex)` is an INVARIANT
    // GUARD: an equivalent handler chain is present at the PR base. Keying the provider is what
    // put it at risk — a consolidation of the two `setTargetIndex` writers this change created
    // would take one of them out — so it is worth pinning, but the red-at-base of this test is
    // attributable to the fallback spelling alone, not to the claim in its title.
    //
    // The selector now lives in the same component as the handler (it was lifted out of the keyed
    // subtree so a key change cannot destroy the control mid-click), so the chain is
    // `onChange` → `handleTargetChange` → `setTargetIndex`. The hop the lift removed is the one
    // that crossed the component boundary: at the PR base the inner component received an
    // `onTargetChange` prop and the chain ran through it.
    const autocomplete = stripComments(
      read('src/components/AutocompleteSearch/AutocompleteSearch.tsx')
    );
    expect(autocomplete).toContain(
      'onChange={(v: string | null) => handleTargetChange(v as SearchIndexKey)}'
    );
    expect(autocomplete).toMatch(
      /const handleTargetChange = \(value: SearchIndexKey\) => \{\s*setTargetIndex\(value\);\s*\};/
    );

    const quickSearch = stripComments(read('src/components/Search/QuickSearchDropdown.tsx'));
    expect(quickSearch).toContain(
      'onChange={(value) => handleTargetChange(value as SearchIndexKey)}'
    );
    expect(quickSearch).toContain('setTargetIndex(value ?? fallbackIndex)');
  });

  it('both selectors are rendered ABOVE the provider a target switch rebuilds', () => {
    // `<InstantSearch>` returns `null` whenever its search instance is not STARTED, and it is
    // started from a subscription callback that runs after a render has committed — so every
    // fresh provider, a key change included, renders once with NO subtree at all. A selector
    // inside it is therefore unmounted and rebuilt by the very click that switched the index, and
    // the focus that click put on it lands on `<body>`. Above the provider it survives its own
    // change handler.
    //
    // File-order, like the carrier check above: a spelling-and-position claim, not a tree one.
    // That is what this tier can see, and it is the property that broke.
    for (const relPath of dropdowns) {
      const source = stripComments(read(relPath));
      const selector = source.indexOf('<Select');
      const provider = source.indexOf('<InstantSearch');

      expect(selector, `${relPath}: no <Select> found`).toBeGreaterThan(-1);
      expect(provider, `${relPath}: <Select> is not written above <InstantSearch>`).toBeGreaterThan(
        selector
      );
    }
  });

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
    //
    // `setTargetIndex` alone. This used to alternate with `onTargetChange`, the spelling the PR
    // base used before the handler was lifted out of the inner component; that name exists nowhere
    // in `src/` now, and the arm could not have discriminated anyway — a revert to the base
    // spelling fails the `indexOf` assertion above before reaching this line.
    expect([...source.matchAll(/setTargetIndex\(searchTarget/g)]).toHaveLength(1);

    // …and it still FOLLOWS navigation. Emptying its dependency array leaves one writer, in the
    // right place, that only ever runs once. The array only has to CONTAIN `searchTarget` —
    // requiring it to be exactly `[searchTarget]` would go red on a legitimate added dependency.
    expect(source.slice(sync)).toMatch(
      /^\s*setTargetIndex\(searchTarget\);[^[\]]{0,300}?\}, \[[^\]]*\bsearchTarget\b[^\]]*\]\)/
    );

    // …and the selector reads the target rather than holding its own copy of it, which a remount
    // would reset while the search really had moved.
    expect(
      containsIgnoringWhitespace(source, SELECTOR_VALUE_CLAMP),
      `AutocompleteSearch: selector value clamp not found — expected ${SELECTOR_VALUE_CLAMP}`
    ).toBe(true);
    expect(source).toContain('data={enabledTargets}');

    // …and it holds NO uncontrolled copy of it. INVARIANT GUARD — green at the PR base too. The
    // PROP, not one spelling of its argument: the previous form named `defaultValue={searchTarget}`
    // and left `defaultValue={targetIndex}` unguarded, which was MEASURED — both dropdowns take a
    // typechecking `defaultValue` revert with the round-1 suite fully green. Scoped to the
    // selector's own source because the text input further down legitimately passes
    // `defaultValue={query}`.
    expect(selectorSource(source)).not.toMatch(/\bdefaultValue=/);

    // INVARIANT GUARD, not regression coverage: this prop predates the PR here. It is load-bearing
    // all the same — this change handler casts away the `null` a deselect produces, and unlike the
    // sibling it has no fallback, so `searchIndexMap[null]` would reach the provider as an
    // undefined index. It is the unguarded copy that a "these two selectors duplicate props"
    // tidy-up would delete.
    expect(source).toContain('allowDeselect={false}');
  });

  it('AutocompleteSearch blurs without emptying the carrier, and clears it on navigation', () => {
    // MEASURED DEFECT, and the reason the carry did nothing on this component: reaching the
    // category selector requires blurring the input, and the blur handler was the CLEAR handler —
    // so `''` was written through the carrier a moment before every selector-driven switch.
    //
    // Two halves, and each is wrong without the other. The blur now empties the display only; the
    // URL-follow effect empties the carrier, so the text survives a pick from the selector and
    // nothing else. Without the second half, text abandoned at a blur reappears — and is searched
    // again — the next time navigation moves the target.
    const source = stripComments(read('src/components/AutocompleteSearch/AutocompleteSearch.tsx'));

    expect(source).toContain('onBlur={handleBlur}');
    expect(source).toContain('onClear={handleClear}');
    expect(source).not.toContain('onBlur={handleClear}');

    // `onClear?.()` in BOTH, and that is not a duplication to tidy away: on mobile `AppHeader`
    // passes `onSearchDone`, so it is what closes the search overlay. A refactor that routes the
    // blur past it leaves the overlay stuck open.
    expect(source).toMatch(
      /const handleClear = \(\) => \{\s*setSearch\(''\);\s*onClear\?\.\(\);\s*\};/
    );
    expect(source).toMatch(
      /const handleBlur = \(\) => \{\s*clearDisplayedText\(\);\s*onClear\?\.\(\);\s*\};/
    );

    // ONE of the three discards, and a SPELLING check: the carrier is emptied when the URL moves
    // the target, immediately before the writer that triggers that remount. The other two —
    // submit and Escape — are pinned in the test below, on the same terms.
    //
    // 🔴 What nothing here covers is that the three are ENOUGH, and they are not. `searchTarget`
    // collapses every first path segment outside `targetData` to `'models'`, so navigation that
    // stays within one section fires none of them and text blurred away then left alone survives
    // to the next selector pick. That is a decision, not an omission; observing it needs a
    // rendered input and a router, which is the browser tier.
    expect(source).toMatch(/carriedSearchText\.current = '';\s*setTargetIndex\(searchTarget\);/);
  });

  it('AutocompleteSearch discards the carried text on submit and on Escape', () => {
    // MEASURED DEFECT at the previous head: the carrier was emptied only when a navigation moved
    // `searchTarget`, so typing on `/`, clicking away and opening a model left text in the
    // carrier with no affordance to discard it — the input reads empty and
    // `clearable={query.length > 0}` removes the clear button — and the next category pick
    // resurrected that text AND searched for it.
    //
    // SPELLING COVERAGE, and it is the only tier available: both paths run through a rendered
    // Mantine input. A rename reddens this for a non-defect; re-pin the new spelling rather than
    // loosening the check.
    const source = stripComments(read('src/components/AutocompleteSearch/AutocompleteSearch.tsx'));

    // Discard and blur in ONE function, so the two "done" paths cannot drift apart.
    expect(source).toMatch(
      /const blurAndDiscardCarriedText = \(\) => \{\s*carriedSearchText\.current = '';\s*blurInput\(\);\s*\};/
    );
    expect(source).toContain("['Escape', blurAndDiscardCarriedText]");
    expect(source).toMatch(
      /const handleSubmit = \(\) => \{[\s\S]{0,400}?blurAndDiscardCarriedText\(\);/
    );

    // 🔴 The complementary half — that the plain blur handler does NOT discard — is not restated
    // here. The test above pins `handleBlur`'s body in FULL, which forbids a discard inside it
    // more tightly than any check written here could, and pins `onBlur={handleBlur}` so the input
    // cannot be rewired to this function instead. One change should redden one test.
  });

  it('QuickSearchDropdown drives its index selector from the target it is searching', () => {
    const source = stripComments(read('src/components/Search/QuickSearchDropdown.tsx'));

    expect(
      containsIgnoringWhitespace(source, SELECTOR_VALUE_CLAMP),
      `QuickSearchDropdown: selector value clamp not found — expected ${SELECTOR_VALUE_CLAMP}`
    ).toBe(true);
    expect(source).toContain('data={enabledTargets}');

    // …and it holds NO uncontrolled copy of the target. 🔴 The previous form here was
    // `not.toContain('defaultValue={enabledTargets[0]}')`, which DISCRIMINATED NOTHING:
    // `enabledTargets` is `{ label, value }[]` while Mantine's `SelectProps['defaultValue']` is
    // `string | null`, so that spelling could never have been written. The plausible reverts —
    // `defaultValue={fallbackIndex}`, `defaultValue={enabledTargets[0].value}` — typecheck, and
    // the first was MEASURED to leave the round-1 suite fully green. Pinned on the PROP now,
    // scoped to the selector's own source because the text input further down legitimately passes
    // `defaultValue={query}`. INVARIANT GUARD: green at the PR base too.
    expect(selectorSource(source)).not.toMatch(/\bdefaultValue=/);

    // DELIBERATELY UNCOVERED, said out loud rather than left as a silent omission: the
    // `startingIndex ?? supportedIndexes[0] ?? 'models'` fallback. Its INITIAL-value arm is
    // unreachable — every caller either passes `startingIndex` or supports `models` first — and
    // its deselect arm needs a rendered Mantine `Select` to reach, which is the browser tier.
    // So reverting it to a bare `'models'` leaves this suite green. Stated rather than pinned:
    // a spelling check here would be an invariant guard wearing a regression guard's title.
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
  /** What the input's blur handler does: empty the display, leave the carrier alone. */
  blur: () => Promise<void>;
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
  let clearDisplay: (() => void) | null = null;
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
    // The blur path, per arm. Carried: the hook's display-only clear. The negative-control arm has
    // no carrier to spare, so its blur is just an empty write — which is also what the CARRIED arm
    // did before this was split, and what made the carry inert on `AutocompleteSearch`.
    clearDisplay = carried ? viaCarrier[2] : () => viaState[1]('');

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
    blur: async () => {
      await act(async () => clearDisplay?.());
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

  it('survives the blur that reaching the category selector requires', async () => {
    // THE PATH THE FEATURE EXISTS FOR, and the one it did not cover. Clicking the selector blurs
    // the input first, so the blur happens BEFORE the index switch, every time. A blur that wrote
    // `''` through the carrier therefore emptied it a moment before the remount that was supposed
    // to restore it, and the whole carry was inert on `AutocompleteSearch`.
    //
    // The input still empties on blur — that is unchanged, and asserted here — but the carried
    // copy is what the remount reads.
    const harness = mount(true);
    await harness.render('models_v9');
    await harness.type('dreamshaper');

    await harness.blur();
    expect(harness.text()).toBe('');

    await harness.render('articles_v6');

    expect(harness.text()).toBe('dreamshaper');
    // …and it is pushed into the rebuilt helper, so the new index is actually searched for it
    // rather than the text merely reappearing. The `''` in the middle is the blur reaching the
    // helper, which is what empties the results behind a blurred input today.
    expect(harness.refinedWith()).toEqual(['dreamshaper', '', 'dreamshaper']);
  });

  it('NEGATIVE CONTROL — the same sequence with the blur written THROUGH the carrier loses the text', async () => {
    // Identical to the test above except for one step: the empty value goes through the ordinary
    // setter instead of the display-only clear. That is exactly what the blur handler used to do,
    // and it drops the text on the very switch the carry exists for — so the difference the test
    // above measures is the split itself, not something the carrier gave you either way. Same
    // carrier, same remount, same assertions; one setter apart.
    const harness = mount(true);
    await harness.render('models_v9');
    await harness.type('dreamshaper');

    await harness.type('');
    await harness.render('articles_v6');

    expect(harness.text()).toBe('');
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
