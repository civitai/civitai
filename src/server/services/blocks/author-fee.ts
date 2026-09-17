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
// 🔴 THIS IS NOT A RATE CARD, AND DELIBERATELY DOES NOT LIVE IN `rate-card.ts`.
// A `RateCard` describes how PLATFORM revenue is split with an author out of
// money the viewer already spent. This fee is new money the viewer pays to the
// author, with no platform share — an opposite-direction quantity that happens
// to be expressed as a percentage. Folding it into `RATE_CARD_V6` would put two
// unrelated economics in one immutable snapshot and make "which percent is
// this?" a reading exercise at every call site.
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

/** Platform CEILING on the percentage leg: 100% of base. Again, no floor. */
export const BLOCK_AUTHOR_FEE_MAX_PCT_OF_BASE = 1;

/**
 * Percentage resolution. The percentage leg is evaluated in BASIS POINTS
 * (1 bp = 0.01%) rather than as a float multiply, so the arithmetic is exact
 * integer arithmetic and the crossover lands where it is supposed to:
 * `floor(20 × 500 / 10000) === 1`, not `floor(20 × 0.05)` with whatever the
 * double rounds to. A fee percentage finer than one basis point is not a
 * quantity anyone can act on, so quantizing at the clamp costs nothing.
 */
export const BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE = 10_000;

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
 * ones that already exist. Deliberately carries NO per-type overrides: the
 * per-type axis is an AUTHOR setting, and there is no author-facing way to set
 * it until slice 3. The empty table is the resolver's real, exercised input, not
 * a placeholder for a table that should have been populated here.
 */
export const BLOCK_AUTHOR_FEE_PLATFORM_CONFIG: BlockAuthorFeeConfig = {
  default: BLOCK_AUTHOR_FEE_DEFAULT_PARAMS,
  byType: [],
};

/** Params after the platform ceiling has been applied, in computable units. */
export type ClampedBlockAuthorFeeParams = {
  /** Integer Buzz in `[0, BLOCK_AUTHOR_FEE_MAX_FLAT_BUZZ]`. */
  readonly flatBuzz: number;
  /** Integer basis points in `[0, BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE]`. */
  readonly pctBasisPoints: number;
  /** True when either leg was out of range (or unusable) and had to be pulled in. */
  readonly clamped: boolean;
};

/**
 * Apply the platform CEILING to a pair, and quantize the percentage leg to
 * basis points.
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
  const rawBasisPoints = pctUsable ? Math.round(rawPct * BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE) : 0;
  const pctBasisPoints = Math.min(Math.max(rawBasisPoints, 0), BLOCK_AUTHOR_FEE_BASIS_POINTS_SCALE);

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
 * The percentage leg FLOORS. Buzz is an integer currency and the fee is
 * additive on top of what the viewer already pays, so the rounding goes toward
 * the viewer: a stated 5% never charges more than 5%. The flat leg is the floor
 * of the whole expression, which is what makes the default meaningful on a cheap
 * generation.
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

export type BlockAuthorFeeObservation =
  | { readonly observed: false; readonly reason: BlockAuthorFeeSkipReason }
  | { readonly observed: true; readonly computation: BlockAuthorFeeComputation };

/**
 * The ONE production entry point, and the dark gate.
 *
 * 🔴 FAIL-CLOSED AND FIRST. The flag is read before anything else happens —
 * before the base is inspected, before any parameter is resolved, before the
 * telemetry module is even imported. With `app-blocks-author-fee-enabled` off,
 * absent, or Flipt unreachable, `isFlipt` answers `false` and this returns
 * immediately, so the computation is unreachable from every production path and
 * emits no signal at all. The flag does not exist in Flipt as this merges, which
 * makes the as-merged behaviour fully dark.
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
 * `outcome` gives the leg mix plus the `base_unavailable` population. The OTHER
 * skip — the flag being off — is deliberately silent here and visible only as
 * `authorFeeSkipped` on the log line, because a gate that has never been turned
 * on must not emit a per-generation metric.
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
    const { isAppBlocksAuthorFeeEnabled } = await import('~/server/services/app-blocks-flag');
    if (!(await isAppBlocksAuthorFeeEnabled())) return { observed: false, reason: 'flag-disabled' };
  } catch {
    // A flag module that will not load is not permission to charge anyone.
    return { observed: false, reason: 'flag-disabled' };
  }

  const {
    blockAuthorFeeBaseBuzzCounter,
    blockAuthorFeeBuzzCounter,
    blockAuthorFeeObservedCounter,
  } = await import('~/server/prom/client').catch(() => ({
    blockAuthorFeeBaseBuzzCounter: null,
    blockAuthorFeeBuzzCounter: null,
    blockAuthorFeeObservedCounter: null,
  }));

  const base = args.baseGenerationBuzz;
  // 🔴 A MISSING BASE IS A SKIP, NOT A ZERO. Treating it as 0 would silently
  // pour "this generation was free" into the same bucket as a genuine zero-base
  // event and understate the fee slice 2 has to size. It gets its own counted
  // outcome so the blind spot is a number rather than an absence.
  if (typeof base !== 'number' || !Number.isFinite(base)) {
    try {
      blockAuthorFeeObservedCounter?.inc({
        coarse_type: BLOCK_AUTHOR_FEE_UNKNOWN_TYPE_LABEL,
        outcome: 'base_unavailable',
      });
    } catch {
      // swallow — telemetry must never back-pressure the caller
    }
    return { observed: false, reason: 'base-unavailable' };
  }

  const computation = computeBlockAuthorFee({
    baseGenerationBuzz: base,
    generationType: args.generationType,
    config: args.config,
  });

  const coarseLabel = computation.coarseType ?? BLOCK_AUTHOR_FEE_UNKNOWN_TYPE_LABEL;
  try {
    blockAuthorFeeObservedCounter?.inc({
      coarse_type: coarseLabel,
      outcome: computation.governingLeg,
    });
    blockAuthorFeeBuzzCounter?.inc({ coarse_type: coarseLabel }, computation.feeBuzz);
    blockAuthorFeeBaseBuzzCounter?.inc(
      { coarse_type: coarseLabel },
      computation.baseGenerationBuzz
    );
  } catch {
    // swallow — telemetry must never back-pressure the caller
  }

  return { observed: true, computation };
}
