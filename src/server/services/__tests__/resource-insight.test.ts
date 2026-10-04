import fs from 'fs';
import path from 'path';
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
 * The membership guard below closes the class for any fixture added later.
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
 * ROW so the document's three meaning axes describe one resource.
 *
 * These pin a NEW contract for one specific defect class — the only defect in this change
 * that nothing else could catch: a projection that selects each axis independently — max
 * score from one version, `role` from another — emits a document whose axes describe
 * DIFFERENT resources. Every field is individually well-formed, the document validates, and
 * Meilisearch answers normally, so there is no symptom anywhere downstream. The
 * discriminating fixture is `role`/`styleFamily` that DIFFER between the winning version and a
 * lower-scoring one; a fixture where every version shares a role cannot see it at all.
 *
 * 🔴 WHAT "RED AT `origin/main`" MEANS FOR THIS BLOCK, stated so it is not over-read. The
 * symbol does not exist there, so all twelve cases fail with
 * `TypeError: modelInsightProjection is not a function` — measured, not inferred; the runner
 * listed twelve individual failures rather than a collection error, and the seven pre-existing
 * `modelInsightQualityScore` cases in the describe above stayed GREEN in the same run. A
 * missing-symbol red cannot discriminate the split-row defect from anything else. What gives
 * these cases their teeth is a mutation battery run at HEAD, in which a per-axis split, a
 * deleted tiebreak, an inverted tiebreak, a deleted floor, an exclusive floor and a row spread
 * were each killed by the named case below and by its own assertion message.
 *
 * Fixture discipline, extending the rule stated at the top of this file to the two new axes:
 * the winner's `role` and `styleFamily` are never the `insight()` default, and every fixture
 * value is a real member of the live option lists — see the membership guard at the end.
 */
describe('modelInsightProjection — the winning version’s whole row', () => {
  it('returns the single labeled version’s three axes', () => {
    const insights = mapOf([
      [11, insight({ qualityScore: 0.42, role: 'style', styleFamily: 'photorealistic' })],
    ]);
    expect(modelInsightProjection([11], insights)).toEqual({
      qualityScore: 0.42,
      role: 'style',
      styleFamily: 'photorealistic',
    });
  });

  it('🔴 carries the WINNER’s role and styleFamily — not another version’s', () => {
    // THE test this function exists for, and it needs TWO arms. A review round measured that a
    // single arm over-claimed: with the winner at the higher id AND carrying the
    // lexicographically larger role, both "role from the max-by-id version" and "three
    // INDEPENDENT maxima, one per field" return exactly the expected object and SURVIVE. The
    // fixtures below are built so each arm kills what the other cannot.
    //
    // Arm A — winner is the HIGHER id (12) and carries the lexicographically SMALLER role and
    // styleFamily. So three independent maxima pick the LOSER's 'style'/'render_3d', and
    // first-wins picks the loser too.
    const armA = mapOf([
      [11, insight({ qualityScore: 0.21, role: 'style', styleFamily: 'render_3d' })],
      [12, insight({ qualityScore: 0.91, role: 'clothing', styleFamily: 'pixel_retro' })],
    ]);
    const expectedA = { qualityScore: 0.91, role: 'clothing', styleFamily: 'pixel_retro' };

    // Arm B — winner is the LOWER id (11). So role-from-the-max-by-id version picks the
    // loser's 'clothing', and last-wins picks the loser too.
    const armB = mapOf([
      [11, insight({ qualityScore: 0.91, role: 'style', styleFamily: 'photorealistic' })],
      [12, insight({ qualityScore: 0.21, role: 'clothing', styleFamily: 'pixel_retro' })],
    ]);
    const expectedB = { qualityScore: 0.91, role: 'style', styleFamily: 'photorealistic' };

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
    // Only "pick one row, then read all three fields off it" passes both arms both ways.
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
    const expected = { qualityScore: 0.77, role: 'clothing', styleFamily: 'pixel_retro' };
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
    });
  });

  it('🔴 projects EXACTLY the three axes — no `confidence`, no `modelVersionId`', () => {
    // `loadResourceInsights` selects `modelVersionId` as well, and its rows therefore carry
    // columns the search document has no business holding. `confidence` is the one that
    // matters: it is the internal label-quality judgment, and the document goes into an index
    // whose displayed-attribute whitelist withholds `insight` precisely so unvalidated
    // internals stay out of a public hit.
    //
    // ⚠️ An earlier version of this comment justified the case by claiming `toEqual` "ignores
    // extra keys on the received object". That is FALSE and was measured false on this repo's
    // own `@vitest/expect`: an extra DEFINED key FAILS `toEqual` (an extra key whose value is
    // `undefined` is what it ignores). So every `toEqual` above already kills a `{ ...best }`
    // spread, via the fixture's `confidence: 0.9`. The sentence is corrected rather than
    // deleted because believing it would license under-specified object assertions elsewhere.
    //
    // This case is kept for the key it adds that no fixture carries — `modelVersionId`, which
    // the real loader DOES put on every row — and because asserting the key SET states the
    // contract directly instead of leaving it as a side effect of one fixture's field count.
    const row = {
      modelVersionId: 11,
      role: 'style',
      styleFamily: 'photorealistic',
      qualityScore: 0.42,
      confidence: 0.88,
    } as unknown as ResourceIntentInsight;
    const got = modelInsightProjection([11], mapOf([[11, row]]));
    expect(got).not.toBeNull();
    expect(Object.keys(got as object).sort()).toEqual(['qualityScore', 'role', 'styleFamily']);
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
    const sources = FIXTURE_SUITES.map((rel) =>
      fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
    ).join('\n');
    const used = (re: RegExp) => [...new Set([...sources.matchAll(re)].map((m) => m[1]))];
    const roles = used(/\brole: '([a-z_]+)'/g);
    const families = used(/\bstyleFamily: '([a-z_]+)'/g);

    // 🔴 Positive control FIRST. A regex that matched nothing would make every assertion below
    // vacuously true, and a reassuring zero is indistinguishable from a probe wired to nothing.
    // More than one distinct value each, since the suites' whole discriminating property is
    // that the winner's values differ from the loser's.
    expect(roles.length, 'the role fixture scan matched nothing').toBeGreaterThan(1);
    expect(families.length, 'the styleFamily fixture scan matched nothing').toBeGreaterThan(1);

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
