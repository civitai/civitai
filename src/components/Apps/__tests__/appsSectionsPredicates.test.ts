import { describe, expect, test } from 'vitest';
import type { AppsNavContext, AppsNavSummary } from '~/components/Apps/apps-sections';
import { appsSections, visibleAppsSections } from '~/components/Apps/apps-sections';

/**
 * 🔒 THE PORT GUARD — `appsSections`' visibility predicates are BEHAVIOURALLY IDENTICAL
 * to the `SUB_NAV_LINKS` table they were moved from.
 *
 * 🔴 WHY THIS FILE EXISTS. The `/apps` nav's tab strip became a left rail, which moved
 * the table from `AppsSubNav.tsx` to `apps-sections.ts`. Every predicate in it is its
 * page's own access gate restated as a viewer fact, and this table has shipped the SAME
 * defect twice — #3899 ("Create" store-gated while `/apps/submit` is author-gated) and
 * again on PR #4668 — both times because a predicate was written or rewritten separately
 * from the gate it mirrors. A LAYOUT CHANGE IS THE MAXIMUM-LIKELIHOOD MOMENT FOR A THIRD
 * INSTANCE: predicates get "cleaned up" while the file they live in is being retyped, and
 * a widened one looks exactly like a tidier one in review.
 *
 * 🔴 THE ORACLE IS TRANSCRIBED FROM `origin/main`, NOT DERIVED FROM THE NEW MODULE.
 * `ORIGIN_MAIN_PREDICATES` below is a hand-copy of `SUB_NAV_LINKS`' six `visible`
 * expressions as they stand at `4aab099c91` — the commit this change is based on. It is
 * an INDEPENDENT WITNESS: a test that re-ran the registry's own predicates would agree
 * with any edit to them, which is precisely the failure this guard exists to prevent.
 * When a predicate is deliberately changed, this file's oracle must be edited in the SAME
 * commit and the change is then visible in the diff — which is the whole point.
 *
 * 🔴 THE WHOLE COHORT SPACE, NOT A SAMPLE. Seven summary booleans and three context
 * booleans is 2^10 = 1024 viewers, and every one of them is compared. A sampled matrix
 * cannot see a predicate that is wrong only for the cohort nobody thought to write down
 * — which is the shape of all three historical instances.
 */

/** The seven `getNavSummary` booleans, in a fixed order so the enumeration is stable. */
const SUMMARY_KEYS = [
  'hasInstalls',
  'hasActivity',
  'hasSubmissions',
  'hasApprovedApps',
  'isReviewer',
  'hasEditableApps',
  'hasPendingInvites',
] as const;

/** The three viewer capabilities. */
const CONTEXT_KEYS = ['isAuthor', 'canBuild', 'canSeeStore'] as const;

/**
 * 🔴 THE ORACLE. Hand-transcribed from `SUB_NAV_LINKS` in
 * `src/components/Apps/AppsSubNav.tsx` at `4aab099c91` (the merge-base of this change),
 * keyed by the href each row pointed at. Do not "simplify" any of these — a simplified
 * oracle silently stops being a witness to what shipped.
 */
const ORIGIN_MAIN_PREDICATES: Record<string, (s: AppsNavSummary, c: AppsNavContext) => boolean> = {
  '/apps': (_s, c) => c.canSeeStore,
  '/apps/activity': (s) => s.hasInstalls || s.hasActivity,
  '/apps/invites': (s, c) => c.isAuthor && s.hasPendingInvites,
  '/apps/revenue': (s) => s.hasApprovedApps,
  '/apps/build': (_s, c) => c.canBuild,
  '/apps/review': (s) => s.isReviewer,
};

/**
 * The ORDER the rows appeared in at `4aab099c91` — discovery → manage → revenue → build
 * → moderate. Pinned separately from the predicates because a re-order changes which
 * destination reads as "what this nav is for" and is a product decision, not a detail.
 */
const ORIGIN_MAIN_ORDER = [
  '/apps',
  '/apps/activity',
  '/apps/invites',
  '/apps/revenue',
  '/apps/build',
  '/apps/review',
] as const;

/** `section.path` → the href it resolves to, mirroring `getAppsSectionHref`. */
const hrefOf = (path: string) => (path ? `/apps/${path}` : '/apps');

/** Every (summary × context) viewer, as a flat list. 2^7 × 2^3 = 1024. */
function everyCohort(): Array<{ summary: AppsNavSummary; context: AppsNavContext }> {
  const out: Array<{ summary: AppsNavSummary; context: AppsNavContext }> = [];
  for (let s = 0; s < 1 << SUMMARY_KEYS.length; s += 1) {
    const summary = Object.fromEntries(
      SUMMARY_KEYS.map((k, i) => [k, Boolean(s & (1 << i))])
    ) as unknown as AppsNavSummary;
    for (let c = 0; c < 1 << CONTEXT_KEYS.length; c += 1) {
      const context = Object.fromEntries(
        CONTEXT_KEYS.map((k, i) => [k, Boolean(c & (1 << i))])
      ) as unknown as AppsNavContext;
      out.push({ summary, context });
    }
  }
  return out;
}

const describeCohort = (summary: AppsNavSummary, context: AppsNavContext) =>
  [...SUMMARY_KEYS.filter((k) => summary[k]), ...CONTEXT_KEYS.filter((k) => context[k])].join(
    '+'
  ) || '(nothing)';

describe('the extractor and the oracle (validate the instrument first)', () => {
  test('the cohort enumeration really is the whole space', () => {
    // A loop over an empty or truncated set is a clean pass over nothing — the reassuring
    // zero this whole file would otherwise be vulnerable to.
    const cohorts = everyCohort();
    expect(cohorts).toHaveLength(1024);
    // …and the cohorts are DISTINCT, so 1024 is not one viewer counted 1024 times.
    const seen = new Set(cohorts.map((x) => describeCohort(x.summary, x.context)));
    expect(seen.size).toBe(1024);
  });

  test('🔴 NEGATIVE CONTROL: the comparison can go RED', () => {
    // Feed the oracle a deliberately-wrong predicate for one row and confirm the
    // cell-by-cell comparison below would notice. Without this, "every cohort agrees"
    // is indistinguishable from a comparison wired to nothing.
    const broken = {
      ...ORIGIN_MAIN_PREDICATES,
      '/apps/invites': (s: AppsNavSummary) => s.hasPendingInvites,
    };
    const disagreements = everyCohort().filter(({ summary, context }) => {
      const actual = appsSections
        .filter((x) => x.visible(summary, context))
        .map((x) => hrefOf(x.path));
      const expected = ORIGIN_MAIN_ORDER.filter((href) => broken[href](summary, context));
      return actual.join(',') !== expected.join(',');
    });
    // The mutant widens Invites to every non-author with a pending invite, so it must
    // disagree on a non-trivial number of cohorts — not merely "at least one".
    expect(disagreements.length).toBeGreaterThan(100);
  });

  test('the registry rows are exactly the rows the oracle knows about, in order', () => {
    // The per-cohort comparison below is keyed by href; a row that vanished from the
    // registry would simply never be compared. This is what makes the set exact.
    expect(appsSections.map((s) => hrefOf(s.path))).toEqual([...ORIGIN_MAIN_ORDER]);
    expect(Object.keys(ORIGIN_MAIN_PREDICATES).sort()).toEqual([...ORIGIN_MAIN_ORDER].sort());
  });
});

describe('🔴 every predicate is behaviourally unchanged from `origin/main`', () => {
  test('all 1024 cohorts resolve to the identical section set', () => {
    const disagreements: string[] = [];
    for (const { summary, context } of everyCohort()) {
      const actual = visibleAppsSections(summary, context).map((s) => hrefOf(s.path));
      const expected = ORIGIN_MAIN_ORDER.filter((href) =>
        ORIGIN_MAIN_PREDICATES[href](summary, context)
      );
      if (actual.join(',') !== expected.join(',')) {
        disagreements.push(
          `${describeCohort(summary, context)}: registry=[${actual.join(', ')}] ` +
            `origin/main=[${expected.join(', ')}]`
        );
      }
    }
    expect(
      disagreements.slice(0, 10),
      `${disagreements.length} cohort(s) resolve to a DIFFERENT section set than the ` +
        '`SUB_NAV_LINKS` table this registry was ported from. Every predicate here is its ' +
        "page's own gate restated as a viewer fact; #3899 and PR #4668 were both a " +
        'predicate rewritten separately from that gate. If the change is deliberate, edit ' +
        'ORIGIN_MAIN_PREDICATES in this same commit so the diff shows what moved.'
    ).toEqual([]);
  });

  /**
   * 🔴 PER-ROW, SO A FAILURE NAMES THE PREDICATE. The test above proves the SET matches
   * and would report a single cohort touching two rows as one line; this one attributes a
   * disagreement to the row that caused it. Both are cheap and they fail differently.
   */
  test.each([...ORIGIN_MAIN_ORDER])('%s: the predicate itself is unchanged', (href) => {
    const section = appsSections.find((s) => hrefOf(s.path) === href);
    expect(section, `${href} is missing from appsSections`).toBeDefined();
    const oracle = ORIGIN_MAIN_PREDICATES[href];

    let sawTrue = false;
    let sawFalse = false;
    for (const { summary, context } of everyCohort()) {
      const actual = section!.visible(summary, context);
      expect(
        actual,
        `${href} @ ${describeCohort(summary, context)}: the ported predicate answers ` +
          `${actual} where \`origin/main\` answered ${oracle(summary, context)}`
      ).toBe(oracle(summary, context));
      if (actual) sawTrue = true;
      else sawFalse = true;
    }
    // 🔴 AND THE PREDICATE IS STILL CONDITIONAL. A row that became `() => true` (or
    // `() => false`) would agree with an oracle mutated the same way, and every
    // assertion above would pass. Marketplace was `() => true` for months and that was
    // exactly the #4668-class exposure.
    expect(sawTrue, `${href} is visible to NOBODY`).toBe(true);
    expect(sawFalse, `${href} is visible to EVERYONE`).toBe(true);
  });
});
