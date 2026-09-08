import { describe, expect, it } from 'vitest';
import {
  APPS_BUILD_STATES,
  resolveAppsBuildSettled,
  resolveAppsBuildState,
  type AppsBuildState,
} from '~/components/Apps/appsBuildState';
import { trackActionSchema } from '~/server/schema/track.schema';

describe('resolveAppsBuildState — the full input table', () => {
  const cases: Array<{
    isAuthor: boolean;
    hasEditableApps: boolean;
    hasSubmissions: boolean;
    expected: AppsBuildState;
  }> = [
    { isAuthor: false, hasEditableApps: false, hasSubmissions: false, expected: 'pitch' },
    // 🔴 A NON-AUTHOR IS `pitch` NO MATTER WHAT THE SUMMARY SAYS. Not hypothetical: an
    // owner who LOSES the author capability keeps their listings, so `hasEditableApps`
    // stays true while `isAuthor` goes false. The workbench reads `appListings.listMine`
    // and its Withdraw carries `enforceAppBlocksFlag`, so rendering it for them would be
    // a table of controls the server refuses.
    { isAuthor: false, hasEditableApps: true, hasSubmissions: false, expected: 'pitch' },
    { isAuthor: false, hasEditableApps: false, hasSubmissions: true, expected: 'pitch' },
    { isAuthor: false, hasEditableApps: true, hasSubmissions: true, expected: 'pitch' },
    { isAuthor: true, hasEditableApps: false, hasSubmissions: false, expected: 'first-app' },
    { isAuthor: true, hasEditableApps: true, hasSubmissions: false, expected: 'workbench' },
    // 🔴 THE ROW THAT MAKES `hasSubmissions` LOAD-BEARING. A submitter whose every
    // listing was deleted has submissions and no editable apps; their orphaned
    // submissions are rendered ONLY by the workbench. Dropping this term from the OR
    // would tell them they have not started yet AND hide the only surface those records
    // have — the same union `/apps/mine`'s sub-nav row carried, for the same reason.
    { isAuthor: true, hasEditableApps: false, hasSubmissions: true, expected: 'workbench' },
    { isAuthor: true, hasEditableApps: true, hasSubmissions: true, expected: 'workbench' },
  ];

  it.each(cases)(
    'author=$isAuthor editable=$hasEditableApps submissions=$hasSubmissions → $expected',
    ({ expected, ...args }) => {
      expect(resolveAppsBuildState(args)).toBe(expected);
    }
  );

  it('🔴 the summary terms are an OR, not an AND', () => {
    // Kills `hasEditableApps && hasSubmissions`, which agrees with the real rule on 6 of
    // the 8 rows above — including every row a hand-written spot check would pick.
    expect(
      resolveAppsBuildState({ isAuthor: true, hasEditableApps: true, hasSubmissions: false })
    ).toBe('workbench');
    expect(
      resolveAppsBuildState({ isAuthor: true, hasEditableApps: false, hasSubmissions: true })
    ).toBe('workbench');
  });

  it('🔴 every state is reachable (guards a constant-returning mutant)', () => {
    // A function that returned one literal would satisfy a table read carelessly; this
    // asserts the image of the function is the whole declared set.
    const produced = new Set(cases.map((c) => resolveAppsBuildState(c)));
    expect([...produced].sort()).toEqual([...APPS_BUILD_STATES].sort());
  });
});

describe('🔴 the pre-settle default the CALLER no longer renders', () => {
  /**
   * `blocks.getNavSummary` runs client-only (tRPC is configured `ssr: false`), so on the
   * server render and the first client paint BOTH summary booleans are false, and this
   * function answers `first-app` for an author.
   *
   * 🔴 THAT IS NO LONGER WHAT THE SERVER HTML CONTAINS **FOR AN AUTHOR WHOSE SUMMARY QUERY IS
   * ENABLED**, AND THIS BLOCK USED TO SAY IT WAS — WITHOUT THE QUALIFIER, WHICH WAS ALSO
   * WRONG. Its docstring read "What the function returns for that input is therefore what the
   * server HTML contains", and its second case was named "an author renders first-app with no
   * summary"; the first correction then over-swung to a bare "an author's server HTML is the
   * skeleton". Both absolutes are false, in opposite directions. `AppsBuildBody` gates the
   * render on `resolveAppsBuildSettled`, which answers `true` — settled, render a state — the
   * moment the query is not enabled. So an author WITHOUT `appBlocks` (admitted to the page by
   * `appListings`) still has state B in their server HTML, permanently; only an author whose
   * query actually runs gets the skeleton. The PR's own browser spec pins that cohort
   * (`author whose summary query is DISABLED settles immediately — no permanent skeleton`).
   *
   * Corrected HERE and not only in `appsBuildState.ts` because a maintainer reading a green
   * `unit` run reads this file, while the module's prose sits beside a browser spec no gate
   * runs at all. ⚠️ That is a readership argument, not an enforcement one — see
   * `resolveAppsBuildSettled` for why "the tier CI blocks on" was itself a false claim.
   *
   * What the cases below still pin is the ARITHMETIC, which is unchanged and correct: for a
   * NON-author it is also still the rendered answer, because a non-author is settled from
   * the first paint and never gets a second render.
   */
  it('a non-author renders pitch with no summary — and never moves off it', () => {
    expect(
      resolveAppsBuildState({ isAuthor: false, hasEditableApps: false, hasSubmissions: false })
    ).toBe('pitch');
  });

  it('an author RESOLVES to first-app with no summary (not rendered), and settles FORWARD to workbench', () => {
    const preMount = resolveAppsBuildState({
      isAuthor: true,
      hasEditableApps: false,
      hasSubmissions: false,
    });
    const postMount = resolveAppsBuildState({
      isAuthor: true,
      hasEditableApps: true,
      hasSubmissions: false,
    });
    expect(preMount).toBe('first-app');
    expect(postMount).toBe('workbench');
    // The direction matters: the transition must never be able to run backwards into the
    // pitch, which would flash a recruiting page at someone who already ships apps.
    expect(preMount).not.toBe('pitch');
  });
});

/**
 * 🔴 THE SEAM BETWEEN THE STATE MACHINE AND THE ANALYTICS SCHEMA.
 *
 * `AppsBuildBody` posts the current state as `details.state` on every `AppsBuild_Action`,
 * and `track.schema.ts` validates it against a CLOSED `z.enum`. The two are in different
 * layers with no type relationship, so renaming a state here is a change the compiler
 * cannot see — and the failure is SILENT in the worst way: `/api/track/batch` rejects the
 * malformed event and the browser still gets a 200, so the funnel simply stops receiving
 * that state's rows and reads as "nobody was ever in it".
 *
 * Pins the two sets EQUAL, so it fails whichever side moves.
 */
describe('🔴 APPS_BUILD_STATES matches the values the tracker will accept', () => {
  it('the analytics enum accepts every state, and no others', () => {
    const arm = trackActionSchema.options.find(
      (o) => o.shape.type.value === 'AppsBuild_Action'
    ) as (typeof trackActionSchema.options)[number] & {
      shape: { details: { shape: { state: { options: readonly string[] } } } };
    };
    expect(arm, 'the `AppsBuild_Action` arm is missing from `trackActionSchema`').toBeDefined();
    expect([...arm.shape.details.shape.state.options].sort()).toEqual(
      [...APPS_BUILD_STATES].sort()
    );
  });

  it('positive control: the schema really does reject an unknown state', () => {
    // Without this, the assertion above could pass against a `z.string()` that accepts
    // everything, and the "closed enum" claim would be prose.
    const ok = trackActionSchema.safeParse({
      type: 'AppsBuild_Action',
      details: { action: 'view', state: 'workbench' },
    });
    const bad = trackActionSchema.safeParse({
      type: 'AppsBuild_Action',
      details: { action: 'view', state: 'not-a-state' },
    });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it('positive control: the schema rejects an unknown ACTION too', () => {
    const bad = trackActionSchema.safeParse({
      type: 'AppsBuild_Action',
      details: { action: 'not-a-step', state: 'pitch' },
    });
    expect(bad.success).toBe(false);
  });

  it('🔴 the four funnel steps are exactly these', () => {
    // The rollup query names these strings. Pinned as a SET so adding a fifth step is a
    // deliberate edit here (and a reminder that `details` is a String column, so a fifth
    // step needs NO ClickHouse migration — only a new enum VALUE would).
    const arm = trackActionSchema.options.find(
      (o) => o.shape.type.value === 'AppsBuild_Action'
    ) as never as { shape: { details: { shape: { action: { options: readonly string[] } } } } };
    expect([...arm.shape.details.shape.action.options].sort()).toEqual([
      'cli_copy',
      'create_entry',
      'request_access',
      'view',
    ]);
  });
});

/**
 * `resolveAppsBuildSettled` — the WHOLE truth table, in the `unit` tier.
 *
 * (That summary line read "in the tier CI blocks on" for one round, eight lines above the
 * paragraph explaining that these rows block nothing. A summary line is what a hurried reader
 * takes away, so it was the worst surviving copy of the claim. Nothing here blocks; see below.)
 *
 * 🔴 THIS SUITE EXISTS BECAUSE THE RENDERED PROOF IS OBSERVED NOWHERE. `/apps/build`'s
 * skeleton is guarded by `AppsBuildBody.browser.test.tsx`, in the `component` project — which
 * `.github/workflows/lint.yml` states plainly is UNGATED: no selector there matches it
 * (`unit*`, `@civitai/*`, `app:*`) and its only CI home is the report-only
 * `preview / component-tests`.
 *
 * ⚠️ THESE ROWS DO NOT "BLOCK" ANYTHING EITHER, AND SAYING THEY DID WAS THIS FILE'S OWN
 * SECOND FALSE CLAIM. The sentence here read "these eight rows are what actually blocks a
 * regression", two lines under the criterion "a guard that can only report is not a guard
 * against the next PR" — which this suite then failed. `unit` is `continue-on-error` on a
 * pull request (`lint.yml:405`) and `main` requires no status checks at all, so no check in
 * this repository prevents a merge. What these rows buy is that `unit` DOES run on
 * `push: [main]` without that flag, so the regression reds the `main` build after it lands
 * rather than going unobserved. Weaker than blocking, stronger than the browser tier, and
 * worth having on those terms — not on the ones first written here.
 *
 * 🔴 THE ROW THAT MATTERS IS `summaryEnabled: false` WITH `isFetched: false`. That is an
 * author whose `getNavSummary` is DISABLED (`appBlocks` off while the page gate,
 * `hasAppsStoreAccess`, admitted them on `appListings`). `isFetched` never goes true for a
 * query that never ran, so the obvious spelling — `!isAuthor || (isClient && isFetched)` —
 * answers `false` for them FOREVER and the caller renders a PERMANENT skeleton. It must
 * answer `true`.
 */
describe('resolveAppsBuildSettled — the full input table', () => {
  const table: Array<{
    summaryEnabled: boolean;
    isClient: boolean;
    isFetched: boolean;
    expected: boolean;
    why: string;
  }> = [
    // The query never runs: nothing is coming, so it is settled on the FIRST paint —
    // server render included. All four combinations, so no row can be satisfied by an
    // implementation that happens to read `isClient` or `isFetched` in this branch.
    {
      summaryEnabled: false,
      isClient: false,
      isFetched: false,
      expected: true,
      why: 'disabled, pre-mount — the permanent-skeleton row',
    },
    {
      summaryEnabled: false,
      isClient: false,
      isFetched: true,
      expected: true,
      why: 'disabled, pre-mount, stale isFetched must not matter',
    },
    {
      summaryEnabled: false,
      isClient: true,
      isFetched: false,
      expected: true,
      why: 'disabled, post-mount',
    },
    {
      summaryEnabled: false,
      isClient: true,
      isFetched: true,
      expected: true,
      why: 'disabled, post-mount, fetched',
    },
    // The query runs: settled only once it has actually answered, on the CLIENT.
    {
      summaryEnabled: true,
      isClient: false,
      isFetched: false,
      expected: false,
      why: 'server render — the summary cannot exist yet',
    },
    {
      summaryEnabled: true,
      isClient: false,
      isFetched: true,
      expected: false,
      why: 'pre-mount with a fetched query — COMBINATORIAL, not reachable: isClient flips once app-wide, so isClient=false implies an empty tRPC cache',
    },
    {
      summaryEnabled: true,
      isClient: true,
      isFetched: false,
      expected: false,
      why: 'mounted, still in flight — the window the skeleton covers',
    },
    {
      summaryEnabled: true,
      isClient: true,
      isFetched: true,
      expected: true,
      why: 'answered (success OR error)',
    },
  ];

  it.each(table)('$why → $expected', ({ summaryEnabled, isClient, isFetched, expected }) => {
    expect(resolveAppsBuildSettled({ summaryEnabled, isClient, isFetched })).toBe(expected);
  });

  it('the table is EXHAUSTIVE over its three booleans, and both verdicts occur', () => {
    // Without this, a row could be dropped in a refactor and the suite would stay green over
    // a predicate nobody checks at that input. 2^3 = 8 distinct combinations.
    const seen = new Set(table.map((r) => `${r.summaryEnabled}|${r.isClient}|${r.isFetched}`));
    expect(seen.size).toBe(8);
    // …and it is not a table of one answer, which `toBe(expected)` alone would not catch.
    expect(new Set(table.map((r) => r.expected))).toEqual(new Set([true, false]));
  });
});
