import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  RESOURCE_INTENT_ROLE_OPTIONS,
  RESOURCE_INTENT_STYLE_FAMILY_OPTIONS,
} from '~/server/schema/resource-intent.schema';
import {
  modelInsightProjection,
  modelInsightQualityScore,
  RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE,
  type ResourceIntentInsight,
} from '~/server/services/resource-insight';

/**
 * The model-level projection rule. Labels are VERSION-level; the models search index is
 * MODEL-level; this is the function that collapses the former into the latter so
 * Meilisearch can order by it.
 *
 * 🔴 NOT regression coverage, in BOTH describes below, and the reasoning differs per block —
 * read it before counting any of this as a red-at-base claim.
 *
 * ⚠️ The `modelInsightQualityScore` block was written when that function was new, under the
 * same reasoning. It is no longer new: as of the meaning-axes change it exists on
 * `origin/main`, those cases pass there, and the sentence that used to sit here ("`…` is new in
 * this change") was simply stale. The regression evidence for THAT arc was the seed-order pair
 * in ./resource-intent-matcher.service.test.ts and the sortable-attributes contract in
 * src/components/Search/__tests__/search-index-contract.test.ts; both still exist.
 *
 * ⚠️ The `modelInsightProjection` block below IS new, and the honest account of its red arm is
 * written at the top of that block. In short: it goes red at `origin/main` on
 * `TypeError: modelInsightProjection is not a function` — a missing symbol, which is evidence
 * the function is new, not evidence that behaviour regressed. The guarantee those cases carry
 * comes from the mutation battery run at HEAD.
 *
 * Fixture discipline: every `qualityScore` below is pairwise distinct AND distinct from
 * `RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE` (0.3), so no assertion here can be satisfied
 * by a mutant that returns the floor, returns a fixed index, or confuses the two fields.
 *
 * 🔴 AND THE SAME DISCIPLINE FOR THE TWO CATEGORICAL AXES, which is a trap rather than a
 * nicety: `role` and `styleFamily` are typed `string` on purpose (the columns are TEXT, so
 * a superseded label stays readable — argued in ./resource-intent-matcher.service.test.ts's
 * subject), so TypeScript accepts ANY spelling here. A review round caught four invented
 * values in this file — `concept` and `painterly`, which exist nowhere, plus `photoreal`
 * and `retro_vintage`, near-misses for the real `photorealistic` and `pixel_retro`. That is
 * the shape that HIDES a real spelling bug instead of exposing one, and worse: the only
 * consumer of `role` refuses to act on a value absent from `RESOURCE_INTENT_ROLE_OPTIONS`,
 * so every "winning" row in this suite sat in the class that consumer discards.
 *
 * The membership guard below closes that class for every `role:` / `styleFamily:` fixture in
 * the files listed in `FIXTURE_SUITES` — and the scope of that sentence is now the scope of
 * the code, which it was not. ⚠️ An audit measured the claim outrunning the implementation: it
 * read "closes the class for any fixture added later" while scanning with `[a-z_]+`, a
 * character class that cannot match a DIGIT, so `render_3d` — a real option, a live fixture
 * value right here — was never scanned and an invented digit-bearing spelling went green. The
 * guard is now an AST walk over property assignments, which has no character class and does
 * not read comments.
 *
 * ⚠️ AND THE SAME CLAIM OUTRAN THE SAME IMPLEMENTATION A SECOND TIME, WHICH IS WHY THE
 * NARROWINGS ARE NOW ENUMERATED INSTEAD OF DISMISSED IN A CLAUSE. This paragraph used to end
 * "a fixture written in a shape it cannot read FAILS rather than being skipped. The one
 * narrowing that remains is the file list itself" — and BOTH halves were false, measured. The
 * walk read its key with `node.name.getText()`, which for a StringLiteral name returns the
 * QUOTES as well, so a quoted key matched nothing and was SKIPPED, not failed: planting
 * `'styleFamily': 'rendr_9d'` left the suite fully green. A computed key `['styleFamily']` was
 * green for the same reason. Both are now closed — `.text` for the quoted form, and for the
 * computed form a loud failure on the NODE KIND, so `ts.ComputedPropertyName` fails whatever its
 * source span says — and both cures carry their controls at the guard.
 *
 * ⚠️ AND THE COMPUTED CURE ITSELF WAS SPELLED BEFORE IT WAS STRUCTURAL, which is the third time
 * a claim in this header outran its implementation. The first version tested
 * `labelKeys.every((k) => !text.includes(k))` — a substring test on the computed name's source
 * span — and said the guard "refuses the shape instead of guessing". It guessed: measured at this
 * head, `const __auditKeys = ['role', 'styleFamily'] as const;` with
 * `{ [__auditKeys[1]]: 'rendr_9d' }` resolves to `styleFamily` carrying an invented non-option
 * and left the suite fully green, because that span mentions neither key. Asserting the node kind
 * has no such hole, and its false-fail set is a strict superset of the substring version's — the
 * only class it adds is the escape set itself. Worked measurements are at the guard.
 *
 * 🔴 THE NARROWINGS THAT ACTUALLY REMAIN, each measured at this head rather than reasoned:
 *   (a) THE FILE LIST. A suite not named in `FIXTURE_SUITES` is not scanned at all.
 *   (b) PROPERTY ASSIGNMENTS WITH LITERAL NAMES AND LITERAL VALUES ARE THE WHOLE SCOPE. A
 *       SHORTHAND property is NOT a `ts.PropertyAssignment`, so a label reaching a fixture as
 *       `insight({ role, styleFamily })` off a hoisted `const` is invisible: RE-MEASURED at
 *       this head, a `const styleFamily = 'rendr_9d'` plus the shorthand reference leaves the
 *       suite `Test Files 5 passed (5)` / `Tests 144 passed (144)` — the figure was 143 before
 *       the whitelist-verbatim case was added next door, so read the count as "all of them",
 *       not as a constant. The same hole covers any value
 *       the walk cannot see as a literal in place — a `SpreadAssignment`, `insight({ ...src })`,
 *       being the other shape with no in-place name/value pair to read. A non-literal value
 *       under a key the walk DOES see still fails loudly; it is the key form and the
 *       indirection that escape.
 *       ⚠️ This used to offer "a whole overrides object passed as a variable" as an instance,
 *       and that OVERSTATED the hole: measured at this head,
 *       `const __auditOverrides = { styleFamily: 'rendr_9d' }; insight(__auditOverrides);` is
 *       CAUGHT with this guard's own message, because the walk scans the whole FILE rather than
 *       `insight(...)` arguments, so that object literal is still a `PropertyAssignment` with a
 *       literal name and a literal value. Define it in a file outside `FIXTURE_SUITES` and it
 *       escapes — but that is narrowing (a), not this one.
 *       🔴 AND THE ASYMMETRY WITH THE COMPUTED-KEY CASE IS DELIBERATE — do not "fix" this half
 *       to match it. A computed key is refused outright because a plain key is a free,
 *       always-available alternative. A `ShorthandPropertyAssignment` has no in-place value the
 *       walk could read and no equally free rewrite to demand, so failing loudly on it would
 *       reject a legal fixture shape rather than redirect it. Documented as a narrowing on
 *       purpose; refusing the computed form is not the precedent for refusing this one.
 *   (c) IT GRADES THE SOURCE ON DISK at `process.cwd()`, not the module the suite imported.
 *
 * ⚠️ ONE COMPENSATING CONTROL, RECORDED RATHER THAN RELIED ON SILENTLY: this repo's prettier
 * config sets no `quoteProps`, so the default `as-needed` applies and `pnpm exec prettier`
 * rewrites `{ 'styleFamily': 'x' }` back to `{ styleFamily: 'x' }`; `prettier:check` runs on
 * changed files, so a NEW quoted-key fixture was already caught by a different gate. That is
 * why the realistic exposure of (3) was small — the computed and shorthand forms are NOT
 * normalised, but they also take deliberate effort to write. The defect worth fixing was the
 * CLAIM, which read as coverage this walk did not provide; the widening is cheap, so it was
 * taken too. The worked history of all three defects is at the guard.
 */

/** The two suites that carry `role`/`styleFamily` fixtures, scanned by the guard below. */
const FIXTURE_SUITES = [
  'src/server/services/__tests__/resource-insight.test.ts',
  'src/server/search-index/__tests__/models-index-insight-projection.test.ts',
];

const insight = (overrides: Partial<ResourceIntentInsight> = {}): ResourceIntentInsight => ({
  role: 'character',
  styleFamily: 'anime_manga',
  qualityScore: 0.5,
  confidence: 0.9,
  ...overrides,
});

const mapOf = (entries: Array<[number, ResourceIntentInsight]>) =>
  new Map<number, ResourceIntentInsight>(entries);

describe('modelInsightQualityScore — one model-level score from many version labels', () => {
  it('returns the score of the single labeled version', () => {
    const insights = mapOf([[11, insight({ qualityScore: 0.42 })]]);
    expect(modelInsightQualityScore([11], insights)).toBe(0.42);
  });

  it('takes the MAX across labeled versions, not the first, last, or mean', () => {
    const insights = mapOf([
      [11, insight({ qualityScore: 0.21 })],
      [12, insight({ qualityScore: 0.91 })],
      [13, insight({ qualityScore: 0.47 })],
    ]);
    // 0.91 is neither first (0.21), last (0.47), nor the mean (~0.53) — so this one
    // assertion discriminates MAX from all three rival rules at once.
    expect(modelInsightQualityScore([11, 12, 13], insights)).toBe(0.91);
  });

  it('is order-independent — the max does not depend on where it sits in the id list', () => {
    const insights = mapOf([
      [11, insight({ qualityScore: 0.91 })],
      [12, insight({ qualityScore: 0.21 })],
    ]);
    expect(modelInsightQualityScore([11, 12], insights)).toBe(0.91);
    expect(modelInsightQualityScore([12, 11], insights)).toBe(0.91);
  });

  it('returns null when the model has no labeled version at all', () => {
    expect(modelInsightQualityScore([11, 12], mapOf([]))).toBeNull();
  });

  it('returns null for an empty version list', () => {
    expect(modelInsightQualityScore([], mapOf([[11, insight()]]))).toBeNull();
  });

  it('ignores labels belonging to OTHER models', () => {
    // The loader is batched across every model in a read window, so the map routinely
    // holds versions this model does not own. Only the passed ids may contribute.
    const insights = mapOf([
      [11, insight({ qualityScore: 0.42 })],
      [999, insight({ qualityScore: 0.97 })],
    ]);
    expect(modelInsightQualityScore([11], insights)).toBe(0.42);
  });

  describe('the promote-confidence floor', () => {
    it('excludes a version below the floor', () => {
      const insights = mapOf([
        [
          11,
          insight({
            qualityScore: 0.91,
            confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE - 0.01,
          }),
        ],
      ]);
      expect(modelInsightQualityScore([11], insights)).toBeNull();
    });

    it('includes a version exactly AT the floor — the bound is inclusive', () => {
      const insights = mapOf([
        [11, insight({ qualityScore: 0.42, confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE })],
      ]);
      expect(modelInsightQualityScore([11], insights)).toBe(0.42);
    });

    it('🔴 takes the max over ELIGIBLE versions only — a high score with low confidence does not win', () => {
      // The discriminating case for this whole function. A "max over everything, then
      // check the floor" implementation returns 0.97; a "max over everything" one also
      // returns 0.97; only "filter by floor, then max" returns 0.42. The two scores are
      // far apart so the difference cannot be a rounding artefact.
      const insights = mapOf([
        [
          11,
          insight({
            qualityScore: 0.97,
            confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE - 0.05,
          }),
        ],
        [12, insight({ qualityScore: 0.42, confidence: 0.88 })],
      ]);
      expect(modelInsightQualityScore([11, 12], insights)).toBe(0.42);
    });

    it('returns null when every labeled version is below the floor', () => {
      const insights = mapOf([
        [11, insight({ qualityScore: 0.91, confidence: 0.1 })],
        [12, insight({ qualityScore: 0.77, confidence: 0.2 })],
      ]);
      expect(modelInsightQualityScore([11, 12], insights)).toBeNull();
    });
  });

  describe('null rather than a sentinel', () => {
    it('🔴 never returns 0 for an unlabeled model', () => {
      // Load-bearing, and measured against Meilisearch v1.15.0: the caller must OMIT the
      // key so the document lands in the engine's trailing group. A 0 would be a real
      // value and would sort ABOVE any negative score and participate in the ordering as
      // if it had been judged. `toBeNull` alone would pass for `0` under a loose check,
      // so the distinction is asserted explicitly.
      const got = modelInsightQualityScore([11], mapOf([]));
      expect(got).toBeNull();
      expect(got).not.toBe(0);
    });

    it('preserves a genuine 0 score from a version that DID clear the floor', () => {
      // The mirror of the above, and the reason the function returns `number | null`
      // rather than using 0 as its own "missing" marker: a model can legitimately be
      // judged 0 with high confidence, and that is NOT the same as unlabeled.
      const insights = mapOf([[11, insight({ qualityScore: 0, confidence: 0.93 })]]);
      expect(modelInsightQualityScore([11], insights)).toBe(0);
    });
  });
});

/**
 * `modelInsightProjection` — the same selection rule, returning the WINNING VERSION'S WHOLE
 * ROW (its three meaning axes) plus that version's id, so the document's axes describe one
 * resource and name which one.
 *
 * These pin a NEW contract for one specific defect class — the only defect in this change
 * that nothing else could catch: a projection that selects each axis independently — max
 * score from one version, `role` from another — emits a document whose axes describe
 * DIFFERENT resources. Every field is individually well-formed, the document validates, and
 * Meilisearch answers normally, so there is no symptom anywhere downstream. The
 * discriminating fixture is `role`/`styleFamily` that DIFFER between the winning version and a
 * lower-scoring one; a fixture where every version shares a role cannot see it at all.
 *
 * 🔴 WHAT "RED AT `origin/main`" MEANS FOR THIS BLOCK, stated so it is not over-read, and
 * RE-DERIVED at this commit rather than carried forward. ⚠️ Every count in this paragraph was
 * WRONG before this commit, in a passage that called itself measured: it said "all twelve
 * cases fail", "the runner listed twelve individual failures", and "the seven pre-existing
 * `modelInsightQualityScore` cases". Re-measured by running THIS file over `origin/main`'s
 * four non-test sources with `--reporter=verbose`:
 *
 *   - this describe holds **13** cases, of which **11** fail with
 *     `TypeError: modelInsightProjection is not a function` — the runner listed 11 individual
 *     failures, not a collection error;
 *   - **2** are GREEN at base, and neither calls the new symbol: `agrees with
 *     \`modelInsightQualityScore\`` (which calls only the old view) and the fixture-membership
 *     guard (which only reads source text). So "all N cases fail" was never the right shape of
 *     claim for this block — two of them cannot fail for a missing symbol;
 *   - the describe ABOVE holds **12** cases, not seven, and all 12 stayed GREEN in the same run.
 *
 * Suite totals in that run, the runner's own lines, across the five files this arc touches:
 * `Test Files 2 failed | 3 passed (5)` / `Tests 18 failed | 126 passed (144)` — 11 from this
 * file and 7 from ../../search-index/__tests__/models-index-insight-projection.test.ts.
 * ⚠️ RE-DERIVED, and BOTH halves moved since this paragraph was written. The denominator went
 * 143 → 144 for the sibling-suite reason the provenance case below now records. The failure
 * count went 17 → 18 for a REAL reason, not an arithmetic one: the searchable whitelist was
 * hoisted out of `onIndexSetup` into
 * ../../search-index/searchable-attributes.ts, so the guard that pins what the engine is given
 * now fails at base too (base passes a function-local, which is exactly what the guard bans).
 * A changing failure count is therefore evidence about the GUARDS, not only about the
 * measurement — read it before assuming a stale total.
 *
 * ⚠️ Also re-derived and also stale: "the describe ABOVE holds 12 cases" is right, but the
 * projection suite next door holds **13** cases, not the 12 its own comment claimed.
 *
 * 🔴 AND THE REASON THOSE NUMBERS WERE WRONG IS THE INSTRUCTION THIS DOCSTRING ALREADY
 * CARRIES, ONE FUNCTION BELOW: "a sweep that fixes a claim must re-derive it AFTER its own
 * edits, not from the state it remembers." The counts were restated from a previous run while
 * the same commit was adding and renaming cases. Any later change to this block must re-run
 * the measurement — the figures above are a property of the case list, and editing the case
 * list invalidates them.
 *
 * A missing-symbol red cannot discriminate the split-row defect from anything else. What gives
 * these cases their teeth is a mutation battery run at HEAD, in which a per-axis split, a
 * deleted tiebreak, an inverted tiebreak, a deleted floor, an exclusive floor, a row spread and
 * two id-provenance mutants (the id read off the row's own column rather than the map key, and
 * the id taken as `min(versionIds)`) were each killed by the named case below and by its own
 * assertion message.
 *
 * Fixture discipline, extending the rule stated at the top of this file to the two new axes:
 * the winner's `role` and `styleFamily` are never the `insight()` default, and every fixture
 * value is a real member of the live option lists — see the membership guard at the end.
 */
describe('modelInsightProjection — the winning version’s whole row', () => {
  it('returns the single labeled version’s three axes and its id', () => {
    const insights = mapOf([
      [11, insight({ qualityScore: 0.42, role: 'style', styleFamily: 'photorealistic' })],
    ]);
    expect(modelInsightProjection([11], insights)).toEqual({
      qualityScore: 0.42,
      role: 'style',
      styleFamily: 'photorealistic',
      modelVersionId: 11,
    });
  });

  it('🔴 carries the WINNER’s role, styleFamily AND id — not another version’s', () => {
    // THE test this function exists for, and it needs TWO arms. A review round measured that a
    // single arm over-claimed: with the winner at the higher id AND carrying the
    // lexicographically larger role, both "role from the max-by-id version" and "three
    // INDEPENDENT maxima, one per field" return exactly the expected object and SURVIVE. The
    // fixtures below are built so each arm kills what the other cannot.
    //
    // 🔴 `modelVersionId` RIDES THE SAME PAIR, and this is the right place for it rather than a
    // case of its own: the contract is that all FOUR values come off ONE row, so the id has to
    // be asserted against the same winner the axes are, in the same fixture, or "the id agrees
    // with the axes" is never actually checked. The two arms disagree about which id wins (12
    // in A, 11 in B), so a hardcoded id, a min-by-id and a max-by-id all die here — and
    // because each arm pins the id and the axes TOGETHER, so does a projection that picks the
    // row for the axes and the id from somewhere else.
    //
    // Arm A — winner is the HIGHER id (12) and carries the lexicographically SMALLER role and
    // styleFamily. So three independent maxima pick the LOSER's 'style'/'render_3d', and
    // first-wins picks the loser too.
    const armA = mapOf([
      [11, insight({ qualityScore: 0.21, role: 'style', styleFamily: 'render_3d' })],
      [12, insight({ qualityScore: 0.91, role: 'clothing', styleFamily: 'pixel_retro' })],
    ]);
    const expectedA = {
      qualityScore: 0.91,
      role: 'clothing',
      styleFamily: 'pixel_retro',
      modelVersionId: 12,
    };

    // Arm B — winner is the LOWER id (11). So role-from-the-max-by-id version picks the
    // loser's 'clothing', and last-wins picks the loser too.
    const armB = mapOf([
      [11, insight({ qualityScore: 0.91, role: 'style', styleFamily: 'photorealistic' })],
      [12, insight({ qualityScore: 0.21, role: 'clothing', styleFamily: 'pixel_retro' })],
    ]);
    const expectedB = {
      qualityScore: 0.91,
      role: 'style',
      styleFamily: 'photorealistic',
      modelVersionId: 11,
    };

    // Both input orders on both arms — the number was already order-independent, but the ROW
    // only becomes so once a tiebreak is defined, and first/last-wins die here.
    for (const ids of [
      [11, 12],
      [12, 11],
    ]) {
      expect(modelInsightProjection(ids, armA), `arm A, ids ${ids}`).toEqual(expectedA);
      expect(modelInsightProjection(ids, armB), `arm B, ids ${ids}`).toEqual(expectedB);
    }

    // What the pair kills, enumerated honestly — each line checked against both arms:
    //   loser's row                  -> arm A gives 'style', arm B gives 'clothing'   FAILS
    //   first-wins / last-wins       -> one of the two orders disagrees on both arms   FAILS
    //   role from the max-by-id      -> arm B gives 'clothing'                         FAILS
    //   role from the min-by-id      -> arm A gives 'style'                            FAILS
    //   three independent maxima     -> arm A gives 'style'/'render_3d'                FAILS
    //   hardcoded `insight()` default-> neither arm's winner is 'character'/'anime_manga' FAILS
    //   id from the min-by-id        -> arm A expects 12, min is 11                     FAILS
    //   id from the max-by-id        -> arm B expects 11, max is 12                     FAILS
    //   id hardcoded to either value -> the other arm disagrees                         FAILS
    // Only "pick one row, then read all four values off it" passes both arms both ways.
    //
    // ⚠️ What this pair canNOT see is the id read off the ROW's own `modelVersionId` COLUMN
    // instead of the map key — here key and column agree, because `insight()` builds rows with
    // no such column at all. The disagreeing fixture that kills that one is in the key-set case
    // below; this comment names the gap so the enumeration above is not read as complete.
  });

  it('🔴 breaks a score tie on the LOWEST version id, in both input orders', () => {
    // A tie was invisible while only the number was projected; it is not invisible now,
    // because the tied versions disagree about `role`. Without a pinned tiebreak the
    // projected role flips between reindexes with no label change behind it — and the
    // caller's list is ordered by `ModelVersion.index`, which is nullable and is the
    // creator's own reorderable display order, so "first in the list" is not stable either.
    //
    // Both orders are asserted and that is what discriminates: FIRST-wins gives 'style' for
    // [12, 11], LAST-wins gives 'style' for [11, 12], and only lowest-id gives 'clothing' for
    // both. Identical scores, so no rule that looks at the score alone can choose.
    const insights = mapOf([
      [11, insight({ qualityScore: 0.77, role: 'clothing', styleFamily: 'pixel_retro' })],
      [12, insight({ qualityScore: 0.77, role: 'style', styleFamily: 'photorealistic' })],
    ]);
    const expected = {
      qualityScore: 0.77,
      role: 'clothing',
      styleFamily: 'pixel_retro',
      modelVersionId: 11,
    };
    expect(modelInsightProjection([11, 12], insights)).toEqual(expected);
    expect(modelInsightProjection([12, 11], insights)).toEqual(expected);
  });

  it('breaks a three-way tie on the lowest id even when it sits mid-list', () => {
    // The lowest id is neither first nor last in the input, so first-wins and last-wins both
    // fail here on a single call. ⚠️ It does NOT kill "sort the input ascending and take the
    // first" — that rule agrees with lowest-id by construction, so there is nothing to kill;
    // an earlier version of this comment claimed it did. Taking the HIGH end is killed.
    const insights = mapOf([
      [11, insight({ qualityScore: 0.64, role: 'clothing', styleFamily: 'pixel_retro' })],
      [12, insight({ qualityScore: 0.64, role: 'style', styleFamily: 'photorealistic' })],
      [13, insight({ qualityScore: 0.64, role: 'character', styleFamily: 'illustration_cartoon' })],
    ]);
    expect(modelInsightProjection([13, 11, 12], insights)).toEqual({
      qualityScore: 0.64,
      role: 'clothing',
      styleFamily: 'pixel_retro',
      modelVersionId: 11,
    });
  });

  it('🔴 ignores a sub-floor version’s axes even when it scores highest', () => {
    // The floor applies to the ROW, not only to the number. Version 11 would win on score
    // and would bring 'style'/'photorealistic' with it; it is below the promote floor, so the
    // projection must come from 12 entirely.
    const insights = mapOf([
      [
        11,
        insight({
          qualityScore: 0.97,
          confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE - 0.05,
          role: 'style',
          styleFamily: 'photorealistic',
        }),
      ],
      [
        12,
        insight({
          qualityScore: 0.42,
          confidence: 0.88,
          role: 'clothing',
          styleFamily: 'pixel_retro',
        }),
      ],
    ]);
    expect(modelInsightProjection([11, 12], insights)).toEqual({
      qualityScore: 0.42,
      role: 'clothing',
      styleFamily: 'pixel_retro',
      modelVersionId: 12,
    });
  });

  it('includes a version exactly AT the floor — the bound is inclusive here too', () => {
    const insights = mapOf([
      [
        11,
        insight({
          qualityScore: 0.42,
          confidence: RESOURCE_INSIGHT_MIN_PROMOTE_CONFIDENCE,
          role: 'style',
          styleFamily: 'photorealistic',
        }),
      ],
    ]);
    expect(modelInsightProjection([11], insights)).toEqual({
      qualityScore: 0.42,
      role: 'style',
      styleFamily: 'photorealistic',
      modelVersionId: 11,
    });
  });

  it('🔴 returns null when every labeled version is below the floor', () => {
    // The caller turns this one null into THREE written nulls. Asserted as a whole-object
    // null rather than per-field, because the contract is "no row", and a mutant returning
    // `{ qualityScore: null, role: 'style', ... }` — a partial row — must fail.
    const insights = mapOf([
      [11, insight({ qualityScore: 0.91, confidence: 0.1, role: 'style' })],
      [12, insight({ qualityScore: 0.77, confidence: 0.2, role: 'clothing' })],
    ]);
    expect(modelInsightProjection([11, 12], insights)).toBeNull();
  });

  it('returns null with no labeled version at all, and for an empty id list', () => {
    expect(modelInsightProjection([11, 12], mapOf([]))).toBeNull();
    expect(modelInsightProjection([], mapOf([[11, insight()]]))).toBeNull();
  });

  it('ignores labels belonging to OTHER models', () => {
    // The loader is batched across a whole read window, so the map routinely holds versions
    // this model does not own — and a leak here would project another model's role.
    const insights = mapOf([
      [11, insight({ qualityScore: 0.42, role: 'clothing', styleFamily: 'pixel_retro' })],
      [999, insight({ qualityScore: 0.97, role: 'style', styleFamily: 'photorealistic' })],
    ]);
    expect(modelInsightProjection([11], insights)).toEqual({
      qualityScore: 0.42,
      role: 'clothing',
      styleFamily: 'pixel_retro',
      modelVersionId: 11,
    });
  });

  it('preserves a genuine 0 score alongside its axes', () => {
    const insights = mapOf([
      [
        11,
        insight({
          qualityScore: 0,
          confidence: 0.93,
          role: 'style',
          styleFamily: 'photorealistic',
        }),
      ],
    ]);
    expect(modelInsightProjection([11], insights)).toEqual({
      qualityScore: 0,
      role: 'style',
      styleFamily: 'photorealistic',
      modelVersionId: 11,
    });
  });

  it('🔴 projects EXACTLY four keys — the three axes and the winning id, never `confidence`', () => {
    // `loadResourceInsights` selects `modelVersionId` as well, and its rows therefore carry a
    // column beyond the four `ResourceIntentInsight` declares. `confidence` is the one that
    // must never travel: it is the internal label-quality judgment, and the document goes into
    // an index whose displayed-attribute whitelist withholds `insight` precisely so
    // unvalidated internals stay out of a public hit.
    //
    // ⚠️ An earlier version of this comment justified the case by claiming `toEqual` "ignores
    // extra keys on the received object". That is FALSE and was measured false on this repo's
    // own `@vitest/expect`: an extra DEFINED key FAILS `toEqual` (an extra key whose value is
    // `undefined` is what it ignores). So every `toEqual` above already kills a `{ ...best }`
    // spread, via the fixture's `confidence: 0.9` — and a bare `best.modelVersionId` too, via
    // the helper row's absent column; the measurements are in the next-but-one paragraph. The
    // sentence is corrected rather than deleted because believing it would license
    // under-specified object assertions elsewhere.
    //
    // 🔴 THE FIXTURE'S `modelVersionId` COLUMN DISAGREES WITH ITS MAP KEY ON PURPOSE, AND THAT
    // IS THE WHOLE POINT OF THIS CASE. The projection is typed to read the id off the KEY —
    // `ResourceIntentInsight` does not declare that column, so nothing type-checks a read of
    // it — and a provenance mutant that reads `best.modelVersionId` takes the ROW's column
    // instead. It returns a well-formed object with a plausible number in it, so only a fixture
    // where the two sources differ can tell them apart. Keyed at 11, column says 999: the
    // assertion below demands 11.
    //
    // 🔴 WHICH PROVENANCE MUTANT THIS CASE IS THE SOLE GUARD FOR IS NARROWER THAN IT LOOKS, AND
    // AN EARLIER VERSION OF THIS COMMENT GOT IT WRONG IN THE DIRECTION THAT COSTS COVERAGE. It
    // read "no other case in this file can see that mutation" of BOTH a `{ ...best }` spread and
    // a bare `best.modelVersionId`, which contradicted the paragraph directly above it and was
    // measured false for both. The eight neighbouring whole-object `toEqual`s DO see both, for
    // two independent reasons: a spread carries the fixture's `confidence`, which `toEqual`
    // rejects as an extra defined key; and every neighbouring row is built by the `insight()`
    // helper, which emits NO `modelVersionId` column at all, so a bare column read yields
    // `undefined` against an expected number. Measured at this head, over the five suites this
    // change touches: `modelVersionId: best.modelVersionId` → `9 failed | 135 passed (144)`, and
    // `return { ...best }` → `9 failed | 135 passed (144)` — the same nine, of which this case
    // is one.
    // ⚠️ Both denominators read `(143)` until they were re-derived; the KILL COUNTS were right
    // and only the totals had moved, because an `it` added in a sibling suite changes the
    // five-suite total without touching this measurement. That is the trap this file's own
    // docstring warns about, two paragraphs of it, and it still caught the sweep that wrote
    // these lines — the author updated the same figure in two other places and missed this
    // block. Re-derive, never restate.
    //
    // The mutant this case is genuinely the SOLE guard for is the FALLBACK form,
    // `best.modelVersionId ?? bestVersionId`: on a helper-built row the absent column falls
    // through to the correct map key, so all eight neighbours stay green, and only a row whose
    // column DISAGREES with its key can see it. Measured: `1 failed | 143 passed (144)`, failing
    // here with this case's own assertion message.
    //
    // 🔴 SO DO NOT TRIM THE NEIGHBOURING `toEqual`s TO PER-FIELD `toBe`s ON THE THEORY THAT THIS
    // CASE IS THE ONLY PROVENANCE GUARD. They are eight-ninths of the kill set for the two
    // likeliest mutants, and a per-field `toBe(…)` on `qualityScore`/`role`/`styleFamily` sees
    // neither — it drops both the extra-key rejection and the absent-column signal. The
    // whole-object form is the coverage; this case only closes the one gap it leaves.
    const row = {
      modelVersionId: 999,
      role: 'style',
      styleFamily: 'photorealistic',
      qualityScore: 0.42,
      confidence: 0.88,
    } as unknown as ResourceIntentInsight;
    const got = modelInsightProjection([11], mapOf([[11, row]]));
    expect(got).not.toBeNull();
    expect(Object.keys(got as object).sort()).toEqual([
      'modelVersionId',
      'qualityScore',
      'role',
      'styleFamily',
    ]);
    expect(
      got?.modelVersionId,
      'the winning id must be the MAP KEY (11), not the row’s own modelVersionId column (999)'
    ).toBe(11);
  });

  it('agrees with `modelInsightQualityScore`, which is now a view over it', () => {
    // The old entry point must keep returning exactly the number it always did. Pinned on the
    // four cases where a re-expression could drift: a plain max, a tie (where the tiebreak now
    // chooses a row but must not move the figure), a genuine 0, and no label at all.
    //
    // ⚠️ ABSOLUTE VALUES ONLY. An earlier version also looped asserting
    // `modelInsightQualityScore(ids, m) === modelInsightProjection(ids, m)?.qualityScore ?? null`
    // — which is a verbatim copy of the view's own body, so ANY change inside the projection
    // (floor flip, tiebreak flip, `>` to `>=`) moved both sides identically and the loop stayed
    // green. That is the "assert against a copy of the implementation" shape; it was deleted
    // rather than kept as reassurance, and these four pins are what carried the case anyway.
    const max = mapOf([
      [11, insight({ qualityScore: 0.21 })],
      [12, insight({ qualityScore: 0.91 })],
    ]);
    const tie = mapOf([
      [11, insight({ qualityScore: 0.77, role: 'clothing' })],
      [12, insight({ qualityScore: 0.77, role: 'style' })],
    ]);
    const zero = mapOf([[11, insight({ qualityScore: 0, confidence: 0.93 })]]);
    expect(modelInsightQualityScore([11, 12], max)).toBe(0.91);
    expect(modelInsightQualityScore([11, 12], tie)).toBe(0.77);
    expect(modelInsightQualityScore([11, 12], zero)).toBe(0);
    expect(modelInsightQualityScore([11, 12], mapOf([]))).toBeNull();
  });

  it('🔴 uses only REAL role/styleFamily values, from the live option lists', () => {
    // The guard for the whole class, because TypeScript cannot help here: `role` and
    // `styleFamily` are typed `string` on purpose (TEXT columns, so a superseded label stays
    // readable), so any spelling compiles. A review round found four invented values in these
    // suites — two that exist nowhere, and two near-misses for `photorealistic` and
    // `pixel_retro`. The near-miss is the dangerous shape: it reads as realistic data while
    // being exactly the "value this build cannot interpret" case that `insightBucket` in
    // ./resource-intent-matcher.service.ts refuses to act on, so every "winning" row in this
    // suite sat in the class the only consumer of `role` discards.
    //
    // Scans the suite SOURCE rather than a hand-maintained list, so a fixture added later is
    // covered without touching this case.
    //
    // 🔴 IT ASKS THE PARSER, NOT THE TEXT, AND BOTH HALVES OF THAT ARE MEASURED DEFECTS IN THIS
    // GUARD'S OWN HISTORY. Do not reduce it to a regex again.
    //
    // (1) The original was `/\brole: '([a-z_]+)'/g`. `[a-z_]+` cannot match a DIGIT, and
    // `render_3d` is the one real option containing one — in use right here as arm A's loser.
    // So that value was never scanned, and an invented digit-bearing spelling in the same slot
    // shipped SILENTLY. Measured, both controls: planting `styleFamily: 'stylee'` (no digit)
    // failed with this case's own message, while planting `styleFamily: 'rendr_9d'` (digit, on
    // a loser row no expectation names) left the file `25 passed (25)` — fully green. The
    // narrow scan saw 4 of the 5 styleFamily values in these suites.
    //
    // (2) The obvious cure — widen the class to `[^']*` — was tried and FAILS, for a reason
    // worth recording because it generalises: a text scan reads COMMENTS. The paragraph you
    // are reading has to name the shape it matches, and the moment it did, `[^']*` captured
    // that prose as a fixture value and the suite went red on a value no fixture ever held.
    // Narrowing the class back would hide the comment and restore defect (1); so a text scan
    // cannot be both wide enough to see every value and narrow enough to ignore the prose
    // describing itself. That is the same lesson, and the same `typescript` devDependency, as
    // the AST walk in ../../search-index/__tests__/models-index-insight-projection.test.ts.
    //
    // So: walk every `role:` / `styleFamily:` PROPERTY ASSIGNMENT and read its string literal.
    // Comments are not property assignments, character classes do not enter into it, and a
    // fixture written in a shape this cannot read fails LOUDLY below rather than escaping — so
    // the claim "covered without touching this case" is now true of the implementation, which
    // is the thing the previous version of this comment asserted without doing.
    // 🔴 THIS GUARD SCANS THE FILE IT LIVES IN, so its own bookkeeping must not contain a
    // `role:` or `styleFamily:` PROPERTY ASSIGNMENT — hence a `Map` built from `labelKeys`
    // rather than the obvious `{ role: [], styleFamily: [] }` accumulator. Measured: that
    // object literal was collected as a fixture and failed this case's own
    // must-be-a-string-literal assertion with `got \`[]\``, pointing at line 560 of this file.
    // Same family as the comment-reading defect above: the scanner's own source is in scope.
    const labelKeys = ['role', 'styleFamily'] as const;
    const found = new Map<string, string[]>(labelKeys.map((key) => [key, []]));
    for (const rel of FIXTURE_SUITES) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
      const ast = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAssignment(node)) {
          // 🔴 READ THE NAME'S `.text`, NOT `getText()` — DEFECT (3), AND IT SURVIVED THE MOVE TO
          // THE AST. For a StringLiteral property name `getText()` returns the source span
          // INCLUDING THE QUOTES, so `'styleFamily': 'x'` yields the key `"'styleFamily'"`,
          // which matches no entry in `labelKeys` and was therefore SKIPPED — the identical
          // silent escape as defect (1), reached through a different mechanism. Measured, both
          // controls, over the five suites this change touches: planting
          // `'styleFamily': 'rendr_9d'` (quoted key, invented digit-bearing value, on a loser
          // row no expectation names) left the suite `Test Files 5 passed (5)` /
          // `Tests 143 passed (143)` — fully green — while the same plant with a BARE key went
          // red with this case's own `fixture styleFamily 'rendr_9d' is not a real option`.
          // ⚠️ THAT `(143)` IS A PRIOR HEAD'S TOTAL, NOT THIS ONE'S — the five-suite total is 144
          // here, and the figure is left unconverted because it dates a measurement taken against
          // the pre-`.text` code, which this tree no longer contains, so it cannot be re-run
          // without reverting the fix. "Fully green" is the load-bearing half and is unaffected;
          // read the denominator as the case count of the head it was taken at.
          // `.text` is quote-free for an Identifier and a StringLiteral alike, which is the fix.
          const name = node.name;
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
          if (ts.isComputedPropertyName(name)) {
            // 🔴 ANY COMPUTED KEY FAILS, REGARDLESS OF WHAT ITS SOURCE SPAN SAYS. A
            // ComputedPropertyName has no `.text` and its span carries the brackets, so
            // `['styleFamily']: 'rendr_9d'` was fully green before this branch existed at all
            // (measured, `143 passed (143)` — again a PRIOR head's total, for the same reason as
            // the paragraph above; the current total is 144). Resolving one in general means evaluating an
            // arbitrary expression, which an AST walk cannot do — so the guard refuses the
            // shape instead of guessing. Write a plain key.
            //
            // 🔴 AND IT ASSERTS THE NODE KIND, NOT THE TEXT — the earlier version of this
            // branch was `labelKeys.every((k) => !text.includes(k))`, a SUBSTRING test on the
            // computed name's source span, i.e. a SPELLED guard that another construct can
            // simply not spell. Measured at this head: planting
            // `const __auditKeys = ['role', 'styleFamily'] as const;` and
            // `{ [__auditKeys[1]]: 'rendr_9d' }` left the suite fully green at
            // `Tests 144 passed (144)` — the key resolves to `styleFamily`, the value is an
            // invented non-option, and nothing was said,
            // while this comment claimed the guard "refuses the shape instead of guessing". It
            // guessed. The span `[__auditKeys[1]]` mentions neither key, which is the whole
            // escape.
            //
            // WHY THE WIDENING IS FREE, measured rather than reasoned:
            //   - The old branch's false-fail set is a STRICT SUBSET of this one's: `['roleplay']`
            //     failed before (its span contains `role`) and fails now. The only class this
            //     ADDS is "a computed name mentioning neither key" — which IS the silent-escape
            //     set above, so there is no trade-off to weigh.
            //   - That set is EMPTY today: an AST sweep of both `FIXTURE_SUITES` found 0
            //     `ComputedPropertyName` nodes against 146 `PropertyAssignment` nodes (the
            //     positive control — the sweep was non-vacuous, and planting one took the count
            //     to 1). So the widening costs nothing now.
            //   - The remedy for a future legitimate one is "write a plain key", which is free
            //     and is already the style at every collected site.
            //   - One condition fewer, and it asserts the STATE — a node kind this walk
            //     provably cannot resolve — rather than a word another construct can spell.
            //
            // ⚠️ DO NOT DO THE SAME TO THE SHORTHAND HOLE, narrowing (b) in this file's header.
            // The asymmetry is justified in THIS direction only. A ShorthandPropertyAssignment
            // is not a `ts.PropertyAssignment` at all and carries no in-place value the walk
            // could read, so failing loudly there would reject a legal fixture shape with no
            // resolvable alternative to offer. A computed key has one — a plain key — which is
            // exactly why refusing it is free here and would not be there.
            expect(
              ts.SyntaxKind[name.kind],
              `${rel}:${line} — a label fixture must use a plain \`role:\` / \`styleFamily:\` property name; this guard cannot resolve ANY computed name, including \`${name.getText(
                ast
              )}\`, and skipping it would be the silent escape defect (1) was`
            ).not.toBe('ComputedPropertyName');
          } else if ((labelKeys as readonly string[]).includes(name.text)) {
            const key = name.text;
            // 🔴 An unreadable fixture must FAIL, not be skipped — a skipped fixture is exactly
            // the silent escape defect (1) was. A template literal, a concatenation or a
            // variable all land here.
            expect(
              ts.isStringLiteral(node.initializer),
              `${rel}:${line} — \`${key}\` fixture must be a plain string literal so this guard can read it; got \`${node.initializer
                .getText(ast)
                .replace(/\s+/g, ' ')}\``
            ).toBe(true);
            found.get(key)?.push((node.initializer as ts.StringLiteral).text);
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(ast, visit);
    }
    const roles = [...new Set(found.get('role') ?? [])];
    const families = [...new Set(found.get('styleFamily') ?? [])];

    // 🔴 Positive control FIRST. A walk that found nothing would make every assertion below
    // vacuously true, and a reassuring zero is indistinguishable from a probe wired to nothing.
    // More than one distinct value each, since the suites' whole discriminating property is
    // that the winner's values differ from the loser's. ⚠️ Asserted on the DISTINCT counts, so
    // a walk that found one value many times cannot satisfy it.
    expect(roles.length, 'the role fixture walk found nothing').toBeGreaterThan(1);
    expect(families.length, 'the styleFamily fixture walk found nothing').toBeGreaterThan(1);
    // And a second control the regex version could not have: `render_3d` — the digit-bearing
    // option defect (1) was blind to — must be among the values actually seen. Pins the cure to
    // the symptom rather than to the mechanism, so a future rewrite that reintroduces a
    // digit-blind scan fails here even if it passes everything else.
    expect(families, 'the digit-bearing option render_3d must be scanned, not skipped').toContain(
      'render_3d'
    );

    for (const role of roles) {
      expect(
        RESOURCE_INTENT_ROLE_OPTIONS as readonly string[],
        `fixture role '${role}' is not a real option`
      ).toContain(role);
    }
    for (const family of families) {
      expect(
        RESOURCE_INTENT_STYLE_FAMILY_OPTIONS as readonly string[],
        `fixture styleFamily '${family}' is not a real option`
      ).toContain(family);
    }
  });
});
