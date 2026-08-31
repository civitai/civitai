import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';

import {
  buildListingStatChips,
  buildRecommendHoverMessage,
} from '~/components/Apps/appListingStatChips';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * The listing detail's header STAT CHIPS + their hover copy (blocking node `unit`
 * project).
 *
 * 🔴 WHY HERE AND NOT IN THE BROWSER SUITE. The chips render inside a Mantine
 * `HoverCard`, so the obvious home for this is `AppListingDetailBody.browser.test.tsx`
 * — and that project is **not run by CI**, and may not run locally at all (the pinned
 * Chromium and the Playwright provider disagree on version). A guard there is invisible
 * to everyone. So the DECISION was extracted into a pure module and is pinned here; the
 * component is a renderer with no branch of its own left to get wrong.
 *
 * 🔴 REGRESSION COVERAGE, not an invariant guard — every `describe` below except the
 * two explicitly labelled otherwise was RED at `617f09c204` and is green at HEAD. The
 * two defects, both live on that commit:
 *   1. the hover message was supplied only when `recommendPct == null`, so with reviews
 *      present the dropdown fell through to the chip's own number and the percentage
 *      was UNREACHABLE;
 *   2. `notRecommendedCount` was rendered nowhere at all.
 */

/**
 * 431 up / 68 down → 0.8637 across 499 reviews. Every number here is pairwise distinct
 * AND distinct from every constant the code under test names (0, 100), so a mutant that
 * hardcodes one cannot be scored green by a fixture that happens to equal it.
 */
const UP = 431;
const DOWN = 68;
const REVIEWS = UP + DOWN; // 499
const INSTALLS = 4213;

type Input = Parameters<typeof buildListingStatChips>[0];

function detail(over: Partial<ListingDetail> = {}): Input {
  return {
    recommend: { recommendedCount: UP, notRecommendedCount: DOWN, recommendPct: UP / REVIEWS },
    reviewCount: REVIEWS,
    installCount: INSTALLS,
    ...over,
  } as Input;
}

const NO_REVIEWS = {
  recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
  reviewCount: 0,
} as const;

const byKey = (chips: { key: string }[]) => chips.map((c) => c.key);

describe('🔴 buildRecommendHoverMessage — the percentage is REACHABLE (F1)', () => {
  it('with reviews, the message carries the rounded percentage and the review count', () => {
    // 431/499 = 0.86373 → 86%. Literal, transcribed by hand, NOT re-derived from
    // `getRecommendLabel` — a test that recomputes the implementation cannot see it
    // being wrong.
    expect(buildRecommendHoverMessage(detail())).toBe("86% recommend (499) · 68 don't");
  });

  it('the message is NOT the chip face number', () => {
    // The exact defect: `message` undefined makes `StatHoverCard` render
    // `value.toLocaleString()`, which is `recommendedCount` — already on the face.
    // Pinned as a discriminator so a regression to `undefined`/`''` fails HERE rather
    // than silently reproducing the chip.
    const message = buildRecommendHoverMessage(detail());
    expect(message).not.toBe(String(UP));
    expect(message).not.toBe(UP.toLocaleString());
    expect(message).toMatch(/%\s*recommend/);
  });

  it('a listing with no reviews gets honest copy, never a bare "0"', () => {
    // 🔴 The reason the fix is "drop the ternary", not "flip it". `!= null` would leave
    // `message` undefined here, and the dropdown would print the chip's own `0`.
    const message = buildRecommendHoverMessage(detail(NO_REVIEWS));
    expect(message).toBe('No reviews yet');
    expect(message).not.toBe('0');
    expect(message).not.toMatch(/%/);
  });

  it('a non-null pct with a zero reviewCount also takes the no-reviews branch', () => {
    // The two fields are separate scalars off one rollup; a 0/0 metric row can produce
    // a pct without a count. Without this the message would read "0% recommend (0)".
    expect(
      buildRecommendHoverMessage(
        detail({
          recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: 0 },
          reviewCount: 0,
        })
      )
    ).toBe('No reviews yet');
  });

  it('the percentage tracks the rollup rather than a constant', () => {
    // Anti-hardcode control: move the input and require the output to move with it. A
    // mutant returning a fixed string, or one that reads the wrong field, dies here even
    // if it happens to match the literal in the first case above.
    expect(
      buildRecommendHoverMessage({
        recommend: { recommendedCount: 4, notRecommendedCount: 133, recommendPct: 4 / 137 },
        reviewCount: 137,
      })
    ).toBe("3% recommend (137) · 133 don't");
  });
});

describe('🔴 buildRecommendHoverMessage — the negative half is rendered (F2)', () => {
  it("the not-recommended count appears, as its own '… don't' clause", () => {
    const message = buildRecommendHoverMessage(detail());
    expect(message).toContain("68 don't");
    // …and it is the NOT-recommended count, not the recommended one wearing that label.
    // With 431 vs 68 the two are distinguishable; a swap fails here.
    expect(message).not.toContain("431 don't");
  });

  it('the count is thousands-separated, like every other public count on the site', () => {
    expect(
      buildRecommendHoverMessage({
        recommend: { recommendedCount: 9, notRecommendedCount: 1234, recommendPct: 9 / 1243 },
        reviewCount: 1243,
      })
    ).toContain("1,234 don't");
  });

  it('the no-review case does NOT append a "0 don\'t" clause', () => {
    expect(buildRecommendHoverMessage(detail(NO_REVIEWS))).not.toContain("don't");
  });

  it('an ABSENT notRecommendedCount degrades to the positive half instead of throwing', () => {
    // Same measured hazard `buildListingDetailRows` carries a note about: the moderator
    // combined-review surface builds a `ListingDetail`-shaped object through a cast, so
    // a declared-required field can be missing at runtime, and
    // `undefined.toLocaleString()` inside a header chip unmounts the whole page.
    const cast = detail() as { recommend: Record<string, unknown> };
    delete cast.recommend.notRecommendedCount;
    let message = '';
    expect(() => {
      message = buildRecommendHoverMessage(cast as Input);
    }).not.toThrow();
    expect(message).toBe('86% recommend (499)');
    expect(message).not.toContain("don't");
    expect(message).not.toContain('undefined');
  });
});

describe('buildListingStatChips — the chip list', () => {
  it('the live posture yields both chips, in order', () => {
    expect(byKey(buildListingStatChips(detail()))).toEqual(['recommend', 'installs']);
  });

  it('each chip carries its face value, accessible name, and hover title', () => {
    const chips = buildListingStatChips(detail());
    const by = Object.fromEntries(chips.map((c) => [c.key, c]));
    expect(by.recommend).toMatchObject({
      label: 'Recommendations',
      value: UP,
      ariaLabel: '431 recommendations',
      message: "86% recommend (499) · 68 don't",
    });
    expect(by.installs).toMatchObject({
      label: 'Installs',
      value: INSTALLS,
      ariaLabel: '4,213 installs',
    });
  });

  it('🔴 the recommend chip ALWAYS carries a message; the installs chip never does', () => {
    // The seam this whole module exists for, stated as a property rather than as one
    // literal — `StatHoverCard` renders `message` INSTEAD of `value`, so:
    //   - recommend: the number is already on the face, so a missing message = a
    //     dropdown that repeats the face. That was the bug.
    //   - installs: the full count IS the content, so a message would replace it with
    //     prose. Spelling the number twice is the mirror-image mistake.
    for (const over of [{}, NO_REVIEWS as Partial<ListingDetail>]) {
      const by = Object.fromEntries(buildListingStatChips(detail(over)).map((c) => [c.key, c]));
      expect(by.recommend.message, JSON.stringify(over)).toBeTruthy();
      expect(by.installs.message, JSON.stringify(over)).toBeUndefined();
    }
  });

  it('a zero installCount still yields the chip — 0 installs is a fact, not an absent field', () => {
    const by = Object.fromEntries(
      buildListingStatChips(detail({ installCount: 0 })).map((c) => [c.key, c])
    );
    expect(by.installs).toBeDefined();
    expect(by.installs.value).toBe(0);
  });
});

describe('🔴 buildListingStatChips — the `preview` posture', () => {
  it('POSITIVE CONTROL: both chips ARE produced in the live posture', () => {
    // The assertion below is a zero. Prove first that this input CAN produce chips, or
    // "no chips in preview" is indistinguishable from a builder that never emits any.
    expect(buildListingStatChips(detail(), { preview: false })).toHaveLength(2);
    expect(byKey(buildListingStatChips(detail(), { preview: false }))).toContain('recommend');
  });

  it('preview yields NO chips (a shadow listing has neither aggregate)', () => {
    expect(buildListingStatChips(detail(), { preview: true })).toEqual([]);
  });

  it('🔴 preview drops the negative count with them', () => {
    // F2 is a review aggregate, so restoring it must not leak it into the moderator
    // preview. Asserted on the SERIALISED list rather than on chip keys, so a future
    // change that keeps the chips but hides them still fails here.
    const serialised = JSON.stringify(buildListingStatChips(detail(), { preview: true }));
    expect(serialised).not.toContain(String(DOWN));
    expect(serialised).not.toContain("don't");
    expect(serialised).not.toContain('%');
    // Positive control for the same three probes, in the arm where they MUST hit.
    const live = JSON.stringify(buildListingStatChips(detail(), { preview: false }));
    expect(live).toContain(String(DOWN));
    expect(live).toContain("don't");
    expect(live).toContain('%');
  });

  it('preview: false is byte-identical to omitting the flag (invariant guard)', () => {
    expect(buildListingStatChips(detail(), { preview: false })).toEqual(
      buildListingStatChips(detail())
    );
  });
});

/**
 * 🔴 SOURCE-LEVEL SEAM GUARD — the component must not re-acquire the branch.
 *
 * INVARIANT GUARD, not regression coverage: it was GREEN at `617f09c204` in the sense
 * that the file did not yet import this module at all. What it pins is that the fix
 * cannot be undone by a one-line edit in the renderer — the shape of the original
 * defect was a ternary on `message` inside `AppListingDetailBody.tsx`, and every test
 * above would stay green if someone put one back there.
 */
describe('🔴 AppListingDetailBody delegates the chip decision (invariant guard)', () => {
  // `fileURLToPath`, not `.pathname` — on Windows the latter yields `/C:/…`, which `readFileSync`
  // then resolves against the drive root as `C:\C:\…` and cannot open.
  const SOURCE = fileURLToPath(new URL('../AppListingDetailBody.tsx', import.meta.url));

  /**
   * A real dependency on the view-model — `from '~/components/Apps/appListingStatChips'`,
   * a dynamic `import(...)`, a `require(...)`, or a side-effect `import '...'`.
   *
   * 🔴 Deliberately NOT a substring test, for the same reason `rating-label.test.ts`'s
   * ledger is not: `/buildListingStatChips/` is satisfied by a COMMENT naming the
   * function, or by any unrelated identifier containing it. A file that had stopped
   * importing the module — and gone back to deciding the chips itself — would still
   * match, so the guard would pass on precisely the change it exists to block.
   */
  const IMPORT_FORM =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"`])~\/components\/Apps\/appListingStatChips\1/;

  it('the source imports the view-model and passes `message` through unconditionally', async () => {
    const fs = await import('fs');
    const raw = fs.readFileSync(SOURCE, 'utf8');

    // Positive control FIRST — both matchers must be able to SEE their target, or the
    // assertions below are zeros from regexes wired to nothing.
    expect(
      "import { buildListingStatChips } from '~/components/Apps/appListingStatChips';"
    ).toMatch(IMPORT_FORM);
    expect('message={x == null ? y : undefined}').toMatch(/message=\{[^}]*\?/);

    // NEGATIVE control — a bare mention must NOT count as a dependency. This is the
    // exact input the old substring matcher accepted.
    expect('// the rule lives in buildListingStatChips, see that module').not.toMatch(IMPORT_FORM);

    expect(
      raw,
      'AppListingDetailBody.tsx no longer imports appListingStatChips. If the chip ' +
        'decision moved back into the component, the hover-message and preview-posture ' +
        'rules are no longer covered by the node project at all.'
    ).toMatch(IMPORT_FORM);
    // No CONDITIONAL message expression anywhere in the file. `message={chip.message}`
    // passes; `message={cond ? a : undefined}` does not.
    expect(
      raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, ''),
      'AppListingDetailBody.tsx is deciding the hover message again. StatHoverCard ' +
        'renders `message` INSTEAD of `value`, so a ternary here is what made the ' +
        'recommend percentage unreachable. The decision belongs in appListingStatChips.'
    ).not.toMatch(/message=\{[^}]*\?/);
  });
});
