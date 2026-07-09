import { buzzBulkBonusMultipliers } from '~/server/common/constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

export const getBuzzBulkMultiplier = ({
  buzzAmount: _buzzAmount,
  purchasesMultiplier,
}: {
  buzzAmount: number;
  purchasesMultiplier: number;
}) => {
  const buzzAmount = Number(_buzzAmount);
  const bulkBuzzMultiplier = buzzBulkBonusMultipliers.reduce((acc, [amount, multiplier]) => {
    if (buzzAmount >= amount) {
      return multiplier;
    }

    return acc;
  }, 1);

  const mainBuzzAdded = Math.floor(buzzAmount * purchasesMultiplier - buzzAmount);
  const blueBuzzAdded = Math.max(
    Math.floor(buzzAmount * bulkBuzzMultiplier - mainBuzzAdded - buzzAmount),
    0
  );

  return {
    buzzAmount,
    purchasesMultiplier,
    bulkBuzzMultiplier,
    blueBuzzAdded,
    mainBuzzAdded,
    totalBlueBuzz: blueBuzzAdded,
    totalCustomBuzz: mainBuzzAdded + buzzAmount,
    totalBuzz: mainBuzzAdded + blueBuzzAdded + buzzAmount,
  };
};

/**
 * Shared currency-derivation core for the on-site generator AND App Blocks.
 *
 * Given any seed `baseTypes` (e.g. `['blue']`) and the SFW/mature maturity of
 * the surface, append the domain currency and return the spend order.
 *
 * Maturity branch (mirrors the product's domain semantics):
 *   - SFW surface (green domain / SFW ceiling)   → append `green`
 *   - mature surface (red domain / mature ceiling) → append `yellow`
 *
 * The seed comes first, so blue (the seeded generation Buzz) is spent before
 * the domain currency — the orchestrator drains `currencies` in array order.
 * Any `yellow`/`green` already present in the seed is stripped so the maturity
 * branch is the single source of truth for which domain currency applies.
 */
function appendDomainCurrency(
  baseTypes: BuzzSpendType[],
  isSfw: boolean
): BuzzSpendType[] {
  const domainTypes: BuzzSpendType[] = baseTypes.filter(
    // Remove default yellow/green if provided.
    (type) => !['yellow', 'green'].includes(type)
  );

  if (isSfw) {
    domainTypes.push('green');
  } else {
    domainTypes.push('yellow');
  }

  return domainTypes;
}

export function getAllowedAccountTypes(
  features: FeatureAccess,
  baseTypes: BuzzSpendType[] = []
): BuzzSpendType[] {
  return appendDomainCurrency(baseTypes, features.isGreen);
}

/**
 * App-Blocks analog of `getAllowedAccountTypes` — the currencies a
 * block-initiated generation may spend, at PARITY with the on-site generator.
 *
 * Blocks have no `ctx.features` (they run off a server-minted JWT, not a
 * session), so the maturity signal is the block token's AUTHORITATIVE SFW
 * ceiling — i.e. `resolveBlockMaturity(claims).isGreen` — NOT the advisory
 * `domain` string claim. This is identical in result to keying on the domain
 * (green domain ⇒ SFW ceiling ⇒ `isGreen` ⇒ blue/green; red domain ⇒ mature
 * ceiling ⇒ blue/yellow) but is forge-safe: it rides the same authoritative
 * ceiling that already drives the output maturity clamp, so the spent currency
 * can never disagree with the clamp.
 *
 *   - SFW (green/blue, `isGreen === true`)  → ['blue', 'green']
 *   - mature (red, `isGreen === false`)     → ['blue', 'yellow']
 *
 * Always blue-first (seeded) — spend drains in array order, same as on-site.
 */
export function getBlockAllowedAccountTypes(isGreen: boolean): BuzzSpendType[] {
  return appendDomainCurrency(['blue'], isGreen);
}

/**
 * PREFERRED-FIRST + DOMAIN-CLAMPED currency ordering for a viewer-picked buzz
 * account (App Blocks money page blocks). The domain-allowed set
 * (`getBlockAllowedAccountTypes`) is the maturity policy gate and is NEVER
 * widened here — a pick can only REORDER within that set:
 *
 *   - no pick               → the allowed set unchanged (`disallowed: false`).
 *     Byte-identical to `getBlockAllowedAccountTypes(isGreen)`, so the Auto path
 *     preserves today's blue-first drain order exactly.
 *   - pick NOT in the set   → `disallowed: true`, allowed set returned unchanged.
 *     The caller REJECTS (never silently spend a different account than asked).
 *   - pick in the set       → the pick moved to the FRONT, the remaining allowed
 *     currencies kept as FALLBACK. The orchestrator drains in array order, so
 *     the picked account pays first but the generation still succeeds when the
 *     total across the allowed accounts covers the cost (preferred-first, then
 *     fall back — a single-account clamp would fail an otherwise-affordable gen).
 *
 * Pure (no throw / no orchestrator-type mapping) so it's unit-testable on the
 * plain `BuzzSpendType` strings; the router wraps it (throws BAD_REQUEST on
 * `disallowed`, then maps to orchestrator currency types).
 */
export function orderBlockCurrencyTypes(
  isGreen: boolean,
  accountType?: BuzzSpendType
): { ordered: BuzzSpendType[]; disallowed: boolean } {
  const allowed = getBlockAllowedAccountTypes(isGreen);
  if (!accountType) return { ordered: allowed, disallowed: false };
  if (!allowed.includes(accountType)) return { ordered: allowed, disallowed: true };
  return {
    ordered: [accountType, ...allowed.filter((type) => type !== accountType)],
    disallowed: false,
  };
}

/**
 * PAYOUT-SAFETY GATE (App Blocks Sybil / payout review).
 *
 * Which Buzz account types are eligible to accrue an app-author payout
 * (`spendSharePct` > 0 / the dark #2605 rev-share rail) when spent inside a
 * block. This is the load-bearing rule that lets block currencies widen to
 * on-site parity (blue/green/yellow) WITHOUT ever turning into a
 * platform-funded farming loop: FREE Buzz is EXCLUDED so a Sybil ring can
 * never mint platform-funded bounty out of free daily Buzz.
 *
 * Determination (from `src/shared/constants/buzz.constants.ts` buzzTypeConfig;
 * PAID vs FREE confirmed by product 2026-06-30 — "green buzz is paid, only
 * blue is free"):
 *   - blue   ('Generation')  → EXCLUDED. The ONLY free type — not `bankable`,
 *                              not `purchasable`; the free/daily-granted
 *                              generation balance. The farming vector.
 *   - green  ('Green')       → ELIGIBLE. `purchasable` — PAID Buzz (the user
 *                              bought/earned it; spending it is a real,
 *                              non-farmable signal).
 *   - yellow ('User')        → ELIGIBLE. `purchasable` — PAID/earned Buzz.
 *   - red    ('FakeRed')     → EXCLUDED. disabled; never a real spend.
 *
 * Rule: PAID (purchasable) types are payout-eligible; the free type (blue) is
 * not. The payout rail (#2605) MUST route every tracked spend row through this
 * predicate before paying — see `computeSpendShare`, which zeroes the share
 * for any non-eligible type. DO NOT widen this set without monetization +
 * Sybil-economics sign-off.
 */
export const PAYOUT_ELIGIBLE_BUZZ_TYPES: ReadonlySet<string> = new Set<BuzzSpendType>([
  'green',
  'yellow',
]);

export function isPayoutEligibleBuzz(buzzType: string | null | undefined): boolean {
  return buzzType != null && PAYOUT_ELIGIBLE_BUZZ_TYPES.has(buzzType);
}
