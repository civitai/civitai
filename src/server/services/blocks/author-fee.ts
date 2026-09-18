import {
  blockAuthorFeeBaseBuzzCounter,
  blockAuthorFeeBuzzCounter,
  blockAuthorFeeObservedCounter,
} from '~/server/prom/client';
import { isAppBlocksAuthorFeeEnabled } from '~/server/services/app-blocks-flag';
import { blockGenerationCoarseType, isBlockGenerationType } from './generation-type';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks PER-GENERATION AUTHOR FEE — the computation and its configuration.
//
// WHAT IT IS. An ADDITIVE, AUTHOR-SET, VIEWER-PAID fee on each generation an app
// runs. The viewer pays it ON TOP OF the base generation cost; the platform
// takes no cut and funds nothing. It replaces the platform-funded percentage
// "bounty" that `block_spend_attribution` still records the basis for
// (status='tracked' / rate_card_version='unrated' / share=0).
//
//   fee = max(flatBuzz, pctOfBase × base_generation_buzz)
//
// ── THE `max` COMBINATOR IS OPERATOR-SPECIFIED, NOT DERIVED ─────────────────
// Verbatim brief: "make it a 'largest of flat or percent'". Not `flat + pct`,
// not a percentage with a floor expressed some other way. Recorded here because
// a requirements audit flagged the combinator as UNATTRIBUTED — which it was,
// only because the reviewer had not been given this line. It is settled; the
// next reader should not re-open it.
//
// 🔴 THIS IS NOT A RATE CARD, AND DELIBERATELY DOES NOT LIVE IN `rate-card.ts`.
// ⚠️ BUT NOT FOR THE REASON AN EARLIER REVISION OF THIS COMMENT GAVE. That
// revision argued that a rate card "splits PLATFORM revenue" while this is new
// money to the author with no platform share. `RATE_CARD_V4`'s own ACCOUNTING
// MODEL note refutes it: the spend bounty a card already carries is "a SEPARATE
// platform expense paid ON TOP … NOT a slice carved out of the viewer's money",
// and the spend table deliberately omits the purchase table's three-way
// conservation CHECK. A card already holds exactly this shape, so "it is not a
// split" is not a reason. The two REAL reasons:
//
//   1. LIFECYCLE — IMMUTABLE PLATFORM SNAPSHOT vs MUTABLE PER-APP SETTING. A
//      `RateCard` is "NEVER mutated in place"; changing a number means a new
//      version constant, and a row stamps `rate_card_version` at WRITE TIME and
//      "pays out under its own snapshot for the lifetime of the row". There is
//      one `ACTIVE_RATE_CARD` for the whole platform. This fee is PER-APP,
//      AUTHOR-SET and MUTABLE: in slice 3 an author edits it and the very next
//      generation charges the new number. One card per app is not ugly, it is
//      structurally impossible — the version string on a row names a
//      platform-wide document, not an app's current setting.
//
//   2. UNITS — PERCENT-OF-USD-CENTS vs BUZZ INTEGERS. Every card field is a
//      percentage applied to CENTS (`publisherSharePctByScope` is a % of
//      `gross_cents - provider_fee_cents`; `spendSharePct` is a % of the
//      spend's USD value), and a flat BUZZ leg has no expression in that unit at
//      all. Worse, the card's per-row CENT FLOORING is precisely the defect that
//      made the bounty pay $0.00: at 10 Buzz per cent (`buzzSpendToUsdCents`)
//      and `spendSharePct: 5`, `computeSpendShare` returns **0 cents for every
//      generation under 200 ⚡** — i.e. for most of them. Computing in Buzz and
//      flooring ONCE, at the end, is what the basis-point arithmetic below
//      exists for.
//
// ── SLICE 1 IS DARK. IT COMPUTES AND OBSERVES; IT MOVES NO MONEY. ───────────
// Settlement onto the licensing-fee rail is slice 2; the author-facing config
// UI and the viewer-facing disclosure are slice 3. Nothing here writes a row,
// reads a row, or touches a Buzz account. `observeBlockAuthorFee` is the ONLY
// production entry point and it is fail-closed behind
// `app-blocks-author-fee-enabled`.
//
// ── NO MIGRATION IN THIS SLICE, ON PURPOSE ──────────────────────────────────
// The defaults apply to EVERY app including the ones that already exist, so
// ABSENCE OF PER-APP CONFIGURATION MEANS THE DEFAULT APPLIES and there is
// nothing to back-fill. Per-app storage only becomes necessary when an author
// can edit it, which is slice 3. Until then the platform defaults and the
// per-type table are code constants here. Every migration on this database is
// applied BY HAND, PER ENVIRONMENT, so a table nobody can write to yet is pure
// cost.
//
// ── THE FEE STACKS ──────────────────────────────────────────────────────────
// It sits alongside, never instead of, the model licensing fee and the lineage
// fee already on a generation. Each party charges for its own contribution; the
// orchestrator already charges the sum of a `fees[]` array and settles each
// entry separately (see `src/pages/api/v1/model-versions/mini/[id].ts`). Slice 1
// computes this app's own entry and stops there.
//
// 🔴 ── `baseGenerationBuzz` IS `WorkflowCost.base`, NOT `WorkflowCost.total` ──
// MEASURED, not assumed. The orchestrator's `WorkflowCost` is
// `{ base, factors, fixed, tips, fees, total }` where `fees` is the per-resource
// LICENSING fee map keyed by resource AIR and `total` INCLUDES both it and the
// tips (`training.orch.ts` sums `cost.fees` precisely to break the licensing
// component back out of `cost.total`). The spend-attribution row's `buzzAmount`
// is derived from the realized paid debit, i.e. a gross that ALREADY CARRIES the
// licensing fee, the lineage fee and the tips.
//
// So `buzzAmount` is the WRONG input. Charging a percentage of it would take a
// percentage of another creator's licensing fee and of the viewer's tip, and
// would compound as more fee-charging resources are stacked onto one
// generation. The caller must pass `cost.base`. This module cannot detect the
// mistake — the two are both plain positive numbers — which is why it is stated
// here and asserted at the one call site rather than left to a reviewer.
//
// (Residual uncertainty, recorded rather than guessed: the orchestrator's own
// docs describe `base` only as "the base cost of this request, excluding any
// tips" and do not say whether `factors`/`fixed` are folded into it. Nothing on
// the App Blocks path reads either field today. If slice 2 needs that
// distinction it has to be settled against the orchestrator, not inferred here.)
// ─────────────────────────────────────────────────────────────────────────────

/** Platform default flat leg: 1 ⚡ per generation. */
export const BLOCK_AUTHOR_FEE_DEFAULT_FLAT_BUZZ = 1;

/** Platform default percentage leg: 5% of the BASE generation Buzz. */
export const BLOCK_AUTHOR_FEE_DEFAULT_PCT_OF_BASE = 0.05;

/**
 * Platform CEILING on the flat leg. There is deliberately NO floor: an author
 * may set either leg to 0, and 0/0 is a valid configuration meaning "this app
 * charges nothing on this generation type" (Justin's motivating case: nothing on
 * chat completions, the default on everything else).
 */
export const BLOCK_AUTHOR_FEE_MAX_FLAT_BUZZ = 100;

/**
 * Platform CEILING on the percentage leg: 100% of base. Again, no floor.
 *
 * 🔴 THIS IS THE ONE SPELLING OF THE CEILING. `BLOCK_AUTHOR_FEE_MAX_PCT_BASIS_POINTS`
 * below is DERIVED from it, and the clamp enforces that derived value — so the
 * policy an author-facing validator reads (slice 3) and the bound the
 * computation enforces cannot disagree. Until this was derived they were two
 * independent numbers that agreed only by coincidence: the clamp capped at
 * `BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE`, which was doing double duty as scale
 * factor AND ceiling, and this constant had no implementation reader at all.
 */
export const BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE = 1;

/**
 * Percentage resolution. The percentage leg is evaluated in BASIS POINTS
 * (1 bp = 0.01%) rather than as a float multiply, so the arithmetic is exact
 * integer arithmetic and the crossover lands where it is supposed to:
 * `floor(20 × 500 / 10000) === 1`, not `floor(20 × 0.05)` with whatever the
 * double rounds to. A fee percentage finer than one basis point is not a
 * quantity anyone can act on, so quantizing at the clamp costs nothing.
 *
 * ⚠️ SCALE FACTOR ONLY. It is NOT the ceiling — see the constant below.
 */
export const BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE = 10_000;

/**
 * The percentage ceiling in the unit the clamp computes in. DERIVED, never
 * written by hand: this is `BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE` expressed in basis
 * points, so moving the declared policy moves the enforced bound with it.
 */
export const BLOCK_AUTHOR_FEE_MAX_PCT_BASIS_POINTS = Math.round(
  BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE * BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE
);

/** The `coarse_type` metric label used when the generation type is unresolvable. */
export const BLOCK_AUTHOR_FEE_UNKNOWN_TYPE_LABEL = 'unknown';

/** One (flat, percent) pair. Both legs are settable from 0 upward. */
export type BlockAuthorFeeParams = {
  /** Flat Buzz leg. `>= 0`, capped at `BLOCK_AUTHOR_FEE_MAX_FLAT_BUZZ`. */
  readonly flatBuzz: number;
  /** Fraction of the base generation Buzz — `0.05` is 5%. `>= 0`, capped at 1. */
  readonly pctOfBase: number;
};

/**
 * A per-generation-type override.
 *
 * 🔴 AN ARRAY OF PAIRS, NOT AN OBJECT MAP — the same safety property, for the
 * same reason, as `IMAGE_SUBTYPE_BY_WORKFLOW` in `generation-type.ts`. The key
 * side is a generation type arriving from a persisted column, and indexing an
 * object literal with such a key fails OPEN (`({} as any)['toString']` is
 * truthy, and a `Partial<Record<…>>` lookup would hand back
 * `Function.prototype.toString` as though it were a fee configuration). A
 * `.find` over a tuple array has no prototype to fall through to. It also keeps
 * ordering explicit, which matters because a full-type entry must be able to
 * beat a coarse-type one.
 *
 * The key is EITHER a full generation type (`textToImage:img2img-edit`,
 * `customComfy:inline`) or a COARSE key (`textToImage`, `chat-completion`).
 * Which one it is decides nothing at declaration time — `resolveBlockAuthorFeeParams`
 * tries the full value first and the coarse key second, so the same table holds
 * both without a discriminator.
 */
export type BlockAuthorFeeTypeOverride = readonly [type: string, params: BlockAuthorFeeParams];

/** An app's fee configuration: a default, plus optional per-type overrides. */
export type BlockAuthorFeeConfig = {
  readonly default: BlockAuthorFeeParams;
  readonly byType?: readonly BlockAuthorFeeTypeOverride[];
};

/** The platform default pair — what every app charges until an author changes it. */
export const BLOCK_AUTHOR_FEE_DEFAULT_PARAMS: BlockAuthorFeeParams = {
  flatBuzz: BLOCK_AUTHOR_FEE_DEFAULT_FLAT_BUZZ,
  pctOfBase: BLOCK_AUTHOR_FEE_DEFAULT_PCT_OF_BASE,
};

/**
 * The PLATFORM configuration — what slice 1 uses for every app, including the
 * ones that already exist.
 *
 * `chat-completion` → 0/0, i.e. NO FEE. This is Justin's motivating example
 * ("nothing on chat completions") implemented as a PLATFORM DEFAULT rather than
 * left for each author to discover in slice 3. Chat completion is the
 * highest-frequency generation type an app runs — a conversational block bills
 * one per turn — so a 1 ⚡ flat floor on each is a per-message toll rather than
 * a fee on a generation. The platform charges nothing there until an author
 * says otherwise.
 *
 * 🔴 THE TABLE BEING NON-EMPTY IS WHAT MAKES THE RESOLVER LIVE IN PRODUCTION.
 * An earlier revision shipped `byType: []` with a comment calling the empty
 * table "the resolver's real, exercised input". It was not: with no entries
 * EVERY production lookup fell to the default, the `type` and `coarse` arms of
 * `resolveBlockAuthorFeeParams` were unreachable outside its own unit tests,
 * and `source` was a compile-time constant `'default'`. A precedence rule that
 * production never executes is not configuration, it is dead code with a test.
 */
export const BLOCK_AUTHOR_FEE_PLATFORM_CONFIG: BlockAuthorFeeConfig = {
  default: BLOCK_AUTHOR_FEE_DEFAULT_PARAMS,
  byType: [['chat-completion', { flatBuzz: 0, pctOfBase: 0 }]],
};

/** Params after the platform ceiling has been applied, in computable units. */
export type ClampedBlockAuthorFeeParams = {
  /** Integer Buzz in `[0, BLOCK_AUTHOR_FEE_MAX_FLAT_BUZZ]`. */
  readonly flatBuzz: number;
  /** Integer basis points in `[0, BLOCK_AUTHOR_FEE_MAX_PCT_BASIS_POINTS]`. */
  readonly pctBasisPoints: number;
  /** True when either leg was out of range (or unusable) and had to be pulled in. */
  readonly clamped: boolean;
};

/**
 * A finite fraction → whole basis points, rounding DOWN.
 *
 * 🔴 IT FLOORS, IT DOES NOT ROUND. `computeBlockAuthorFee` promises that "a
 * stated 5% never charges more than 5%", and `Math.round` breaks that promise at
 * the quantization step before the fee is ever computed: a stated `0.049999`
 * rounds UP to 500 bp and charges a full 5%. Flooring makes the guarantee exact
 * — 499 bp — and keeps every rounding in this module pointed the same way, at
 * the viewer.
 *
 * ⚠️ THE `toFixed` IS NOT DECORATION — a naive `Math.floor(pct * SCALE)` LOSES A
 * BASIS POINT ON 573 OF THE 10,001 EXACT BASIS-POINT INPUTS (measured), because
 * a value like `0.0029` is not exactly representable and `0.0029 * 10_000` lands
 * at `28.999999999999996`. An author typing 0.29% would be charged 0.28%.
 * Normalising to 6 decimal places first — far finer than one basis point, so it
 * cannot mask a genuine sub-bp fraction — makes every exact basis-point input
 * exact (measured: 0 of 10,001 wrong) while still flooring `0.049999` to 499.
 */
function toBasisPoints(pct: number): number {
  return Math.floor(Number((pct * BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE).toFixed(6)));
}

/**
 * Apply the platform CEILING to a pair, and quantize the percentage leg to
 * basis points.
 *
 * The percentage ceiling enforced here is `BLOCK_AUTHOR_FEE_MAX_PCT_BASIS_POINTS`,
 * which is DERIVED from `BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE` — so the number an
 * author-facing validator reads and the number this enforces are one value, not
 * two that happen to agree.
 *
 * Clamps rather than rejects. Slice 1's only config source is a code constant,
 * but slice 3's is author input, and a fee path that throws on a bad number is a
 * fee path that can take down a generation submit. Clamping is also the correct
 * answer in its own right: the ceiling is the platform's, so a configuration
 * above it is not an error to report back, it is a number the platform declines
 * to honour. A non-finite or missing leg collapses to 0 — the safe direction,
 * since 0 charges the viewer nothing.
 *
 * `clamped` is reported (and surfaced as a log field) rather than swallowed, so
 * a configuration that is silently not doing what its author asked is visible.
 */
export function clampBlockAuthorFeeParams(
  params: BlockAuthorFeeParams
): ClampedBlockAuthorFeeParams {
  const rawFlat = params.flatBuzz;
  const flatUsable = typeof rawFlat === 'number' && Number.isFinite(rawFlat);
  const flatFloor = flatUsable ? Math.floor(rawFlat) : 0;
  const flatBuzz = Math.min(Math.max(flatFloor, 0), BLOCK_AUTHOR_FEE_MAX_FLAT_BUZZ);

  const rawPct = params.pctOfBase;
  const pctUsable = typeof rawPct === 'number' && Number.isFinite(rawPct);
  const rawBasisPoints = pctUsable ? toBasisPoints(rawPct) : 0;
  const pctBasisPoints = Math.min(
    Math.max(rawBasisPoints, 0),
    BLOCK_AUTHOR_FEE_MAX_PCT_BASIS_POINTS
  );

  // Quantizing 0.050001 to 500 bp is NOT a clamp — only leaving the permitted
  // range is, plus a leg that was not a usable number to begin with.
  const clamped =
    !flatUsable || !pctUsable || flatBuzz !== flatFloor || pctBasisPoints !== rawBasisPoints;

  return { flatBuzz, pctBasisPoints, clamped };
}

/** Which level of the config answered the lookup. */
export type BlockAuthorFeeParamsSource = 'type' | 'coarse' | 'default';

export type BlockAuthorFeeParamsResolution = {
  readonly params: BlockAuthorFeeParams;
  readonly source: BlockAuthorFeeParamsSource;
  /** The coarse key the fee was looked up under, or `null` if unresolvable. */
  readonly coarseType: string | null;
};

/**
 * Resolve the (flat, percent) pair for one generation type.
 *
 * PRECEDENCE, most specific first:
 *   1. an override whose key is the FULL generation type (`textToImage:img2img`)
 *   2. an override whose key is its COARSE key (`textToImage`)
 *   3. the config default
 *
 * The parameters are "per generation type" at the COARSE level — that is the key
 * `blockGenerationCoarseType` exists to produce and the level Justin's example
 * operates at ("nothing on chat completions") — with the full-type override
 * available for a case that needs to split one coarse key. For a value that
 * carries no subtype the two keys are the same string, so an entry for it
 * reports `source: 'type'`; that is a labelling detail, not a different answer.
 *
 * 🔴 THE LOOKUP KEY IS BOUNDED BEFORE IT IS USED. `generationType` arrives as
 * `unknown` (it is read off a nullable column), and `isBlockGenerationType` is
 * the one place that says what a legal value is. An unrecognised value —
 * including `null`, a typo, and a value from a build with a wider registry —
 * resolves to the DEFAULT rather than to no fee: the defaults apply to
 * everything, and a generation we could not type is still a generation. That is
 * also why no prototype-key guard is written here. With the key bounded to the
 * registry-derived sets, a string like `'toString'` can never reach the `.find`,
 * so such a guard would be unreachable — and an unreachable guard reads as
 * coverage while providing none.
 *
 * ⚠️ CONSEQUENCE WORTH KNOWING BEFORE SLICE 3: an author who zeroes the fee for
 * one type is NOT protected by that setting on a generation whose type failed to
 * resolve — it falls to their default. Resolution failure is rare and already
 * visible (`generation_type` is NULL on the row, and the observation counter
 * carries `coarse_type="unknown"`), but the direction of the fallback is a
 * decision, and this is it.
 */
export function resolveBlockAuthorFeeParams(
  config: BlockAuthorFeeConfig,
  generationType: unknown
): BlockAuthorFeeParamsResolution {
  const overrides = config.byType ?? [];
  const knownType = isBlockGenerationType(generationType) ? generationType : null;
  const coarseType = blockGenerationCoarseType(knownType);

  if (knownType !== null) {
    const exact = overrides.find(([key]) => key === knownType);
    if (exact) return { params: exact[1], source: 'type', coarseType };

    if (coarseType !== null) {
      const coarse = overrides.find(([key]) => key === coarseType);
      if (coarse) return { params: coarse[1], source: 'coarse', coarseType };
    }
  }

  return { params: config.default, source: 'default', coarseType };
}

/** Which leg of `max(flat, pct)` decided the fee. `'none'` iff the fee is 0. */
export type BlockAuthorFeeLeg = 'flat' | 'pct' | 'none';

export type BlockAuthorFeeComputation = {
  /** The fee in Buzz. Always `Math.max(flatLegBuzz, pctLegBuzz)`. */
  readonly feeBuzz: number;
  /** The normalized base the percentage leg was taken of. */
  readonly baseGenerationBuzz: number;
  readonly flatLegBuzz: number;
  readonly pctLegBuzz: number;
  readonly governingLeg: BlockAuthorFeeLeg;
  readonly source: BlockAuthorFeeParamsSource;
  readonly coarseType: string | null;
  readonly clamped: boolean;
};

/**
 * `fee = max(flatBuzz, pctOfBase × base_generation_buzz)`, in whole Buzz.
 *
 * 🔴 ZERO BASE ⇒ ZERO FEE, AND IT IS A SEPARATE RULE FROM THE FORMULA. A plain
 * `max(1, 5% × 0)` is 1, so the flat leg would MINT a fee out of a generation
 * that cost nothing. That is not a hypothetical: zero-base generations happen
 * (17 of 600 measured events), and charging for one is the single most
 * indefensible thing this computation could do. The guard is stated first and
 * returns before the legs are evaluated.
 *
 * The percentage leg FLOORS — at BOTH steps, which is what makes the guarantee
 * exact rather than approximate: the stated fraction floors to whole basis
 * points in `toBasisPoints`, and the resulting Buzz floors again here. Buzz is an
 * integer currency and the fee is additive on top of what the viewer already
 * pays, so every rounding goes toward the viewer: a stated 5% never charges more
 * than 5%. The flat leg is the floor of the whole expression, which is what makes
 * the default meaningful on a cheap generation.
 *
 * At the CROSSOVER the legs are equal and `governingLeg` reports `'flat'` — an
 * arbitrary but pinned tie-break, chosen so the leg that is always present wins
 * and a rounding wobble cannot flip the reported label back and forth.
 *
 * Total and non-throwing. `baseGenerationBuzz` is typed `unknown` because the
 * only production caller reads it off an optional orchestrator response field;
 * anything that is not a finite positive number is treated as a zero base.
 */
export function computeBlockAuthorFee(args: {
  /** 🔴 The BASE generation cost — `WorkflowCost.base`, never `.total`. */
  baseGenerationBuzz: unknown;
  generationType: unknown;
  config?: BlockAuthorFeeConfig;
}): BlockAuthorFeeComputation {
  const config = args.config ?? BLOCK_AUTHOR_FEE_PLATFORM_CONFIG;
  const { params, source, coarseType } = resolveBlockAuthorFeeParams(config, args.generationType);
  const { flatBuzz, pctBasisPoints, clamped } = clampBlockAuthorFeeParams(params);

  const rawBase = args.baseGenerationBuzz;
  const baseGenerationBuzz =
    typeof rawBase === 'number' && Number.isFinite(rawBase) && rawBase > 0
      ? Math.floor(rawBase)
      : 0;

  if (baseGenerationBuzz === 0) {
    // Both legs report 0 rather than the configured flat value, so the invariant
    // `feeBuzz === max(flatLegBuzz, pctLegBuzz)` holds on every branch and a
    // reader of the log line cannot mistake an uncharged flat leg for a charged one.
    return {
      feeBuzz: 0,
      baseGenerationBuzz: 0,
      flatLegBuzz: 0,
      pctLegBuzz: 0,
      governingLeg: 'none',
      source,
      coarseType,
      clamped,
    };
  }

  const pctLegBuzz = Math.floor(
    (baseGenerationBuzz * pctBasisPoints) / BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE
  );
  const flatLegBuzz = flatBuzz;
  const feeBuzz = Math.max(flatLegBuzz, pctLegBuzz);

  return {
    feeBuzz,
    baseGenerationBuzz,
    flatLegBuzz,
    pctLegBuzz,
    governingLeg: feeBuzz === 0 ? 'none' : pctLegBuzz > flatLegBuzz ? 'pct' : 'flat',
    source,
    coarseType,
    clamped,
  };
}

/** Why an observation produced no computation. */
export type BlockAuthorFeeSkipReason = 'flag-disabled' | 'base-unavailable';

/**
 * ONE SPELLING of the missing-base skip, shared by the Prometheus `outcome`
 * label and the Axiom `authorFeeSkipped` field. The counter used to say
 * `base_unavailable` while the log line said `base-unavailable` — two spellings
 * of one concept across the two instruments the slice-2 sizing read joins, which
 * is exactly the join that then silently returns nothing.
 */
export const BLOCK_AUTHOR_FEE_BASE_UNAVAILABLE: BlockAuthorFeeSkipReason = 'base-unavailable';

export type BlockAuthorFeeObservation =
  | { readonly observed: false; readonly reason: BlockAuthorFeeSkipReason }
  | { readonly observed: true; readonly computation: BlockAuthorFeeComputation };

/**
 * The ONE production entry point, and the dark gate.
 *
 * 🔴 FAIL-CLOSED AND FIRST. The flag is read before anything else happens —
 * before the base is inspected and before any parameter is resolved. With
 * `app-blocks-author-fee-enabled` off, absent, or Flipt unreachable, `isFlipt`
 * answers `false` and this returns immediately, so the computation is
 * unreachable from every production path and emits no signal at all. The flag
 * does not exist in Flipt as this merges, which makes the as-merged behaviour
 * fully dark.
 *
 * ⚠️ AN EARLIER REVISION ALSO CLAIMED THE FLAG IS READ "before the telemetry
 * module is even imported", and used `await import()` for both dependencies to
 * make that true. IT WAS NOT TRUE AND THE INDIRECTION DEFERRED NOTHING: the
 * sole caller `buzz-attribution.service` STATICALLY imports
 * `~/server/prom/client`, and `blocks.router` — which imports that service —
 * statically imports `app-blocks-flag`. Both modules are already in the module
 * cache before this function is entered, so the dynamic form bought no
 * deferral, and the `.catch(() => ({ …: null }))` fallback it carried was
 * unreachable. Both are ordinary static imports now and the claim is deleted
 * rather than reworded.
 *
 * 🔴 WHAT PINS THE ORDER, EXACTLY. Two different assertions, because one of them
 * does less than it reads like it does:
 *   - the counter assertions pin only that NOTHING IS EMITTED on the disabled
 *     path. `computeBlockAuthorFee` is pure, so a copy of it hoisted above the
 *     flag read emits nothing either and those assertions stay green — they are
 *     not an ordering guard and must not be read as one.
 *   - the ordering itself is pinned by `does not touch its own ARGUMENTS`, which
 *     hands this function an args object whose `generationType` and `config` are
 *     GETTERS. Neither is read anywhere but inside the `computeBlockAuthorFee`
 *     call below, so a read with the flag off means the computation ran early.
 *     Slice 2 replaces "pure computation" with "moves money", at which point
 *     this is the guard that matters.
 *
 * OPERATOR NOTE: create `app-blocks-author-fee-enabled` as a PLAIN GLOBAL
 * BOOLEAN with no segment. This evaluates globally (entityId `'global'`, empty
 * context), so no segment can ever match and the answer is always the flag's
 * BASE value — a base-`false` flag decorated with a rollout stays dark for
 * everyone, and (the non-fail-safe direction) a base-`true` flag decorated with
 * one is ON for everyone. Set the base, do not decorate it.
 *
 * MAKES THE FEE OBSERVABLE WITHOUT STORING IT. Slice 2 has to be sized from real
 * traffic before anyone is charged, and nothing here persists a number: the
 * computation goes to the same two places the spend attribution already reports
 * to — three Prometheus counters and the `block-spend-attribution` Axiom line.
 * `block_author_fee_buzz_total / block_author_fee_base_buzz_total` by coarse
 * type gives the realized effective rate; `block_author_fee_observed_total` by
 * `outcome` gives the leg mix plus the `base-unavailable` population — in the
 * SAME spelling the log line's `authorFeeSkipped` uses, so the two instruments
 * join. The OTHER skip — the flag being off — is deliberately silent here and
 * visible only as `authorFeeSkipped` on the log line, because a gate that has
 * never been turned on must not emit a per-generation metric.
 *
 * TOTAL AND NON-THROWING. Every caller is on a fire-and-forget path off an
 * already-billed submit. A telemetry failure, a flag-read failure, or anything
 * else degrades to a skip — this must never become a new way for the spend path
 * to throw.
 */
export async function observeBlockAuthorFee(args: {
  /** 🔴 `WorkflowCost.base`. Absent/unusable → a `base-unavailable` skip. */
  baseGenerationBuzz: number | null | undefined;
  generationType: unknown;
  config?: BlockAuthorFeeConfig;
}): Promise<BlockAuthorFeeObservation> {
  try {
    if (!(await isAppBlocksAuthorFeeEnabled())) return { observed: false, reason: 'flag-disabled' };
  } catch {
    // A flag read that will not resolve is not permission to charge anyone.
    return { observed: false, reason: 'flag-disabled' };
  }

  const base = args.baseGenerationBuzz;
  // 🔴 A MISSING BASE IS A SKIP, NOT A ZERO. Treating it as 0 would silently
  // pour "this generation was free" into the same bucket as a genuine zero-base
  // event and understate the fee slice 2 has to size. It gets its own counted
  // outcome so the blind spot is a number rather than an absence.
  if (typeof base !== 'number' || !Number.isFinite(base)) {
    try {
      blockAuthorFeeObservedCounter.inc({
        coarse_type: BLOCK_AUTHOR_FEE_UNKNOWN_TYPE_LABEL,
        outcome: BLOCK_AUTHOR_FEE_BASE_UNAVAILABLE,
      });
    } catch {
      // swallow — telemetry must never back-pressure the caller
    }
    return { observed: false, reason: BLOCK_AUTHOR_FEE_BASE_UNAVAILABLE };
  }

  const computation = computeBlockAuthorFee({
    baseGenerationBuzz: base,
    generationType: args.generationType,
    config: args.config,
  });

  const coarseLabel = computation.coarseType ?? BLOCK_AUTHOR_FEE_UNKNOWN_TYPE_LABEL;
  try {
    blockAuthorFeeObservedCounter.inc({
      coarse_type: coarseLabel,
      outcome: computation.governingLeg,
    });
    blockAuthorFeeBuzzCounter.inc({ coarse_type: coarseLabel }, computation.feeBuzz);
    blockAuthorFeeBaseBuzzCounter.inc({ coarse_type: coarseLabel }, computation.baseGenerationBuzz);
  } catch {
    // swallow — telemetry must never back-pressure the caller
  }

  return { observed: true, computation };
}
