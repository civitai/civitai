// Scheduled sales — the authoring rules, as pure functions. Spec: CU 868ktk1ku.
//
// A sale is an OVERLAY: it never writes the base price, so the effective price is resolved at read time
// from the base terms and the covering sales. Nothing here computes a discounted price, a budget total,
// or whether a sale is active — those live in @civitai/buzz (`discountedTerms`, `saleDaysUsed`,
// `isSaleActive`) so this app and the main app cannot disagree about what a buyer is charged.

import {
  bestSaleFor,
  isSaleActive,
  maxSaleDays,
  maxSaleLeadDays,
  minCreatorScoreForSale,
  saleDaysUsed,
  saleDiscountFor,
  type ModelVersionSaleWindow,
  type SaleLimitOverrides,
} from '@civitai/buzz';

export { maxSaleDays, maxSaleLeadDays, minCreatorScoreForSale };

export type SaleDiscountType = 'Fixed' | 'Percent';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Days a window consumes from the budget. Rounded up, and never less than 1: a sale that exists at all
 * costs a day, otherwise a chain of 23-hour sales spends nothing.
 */
export function saleLengthInDays(startsAt: Date, endsAt: Date): number {
  const ms = endsAt.getTime() - startsAt.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.ceil(ms / DAY_MS));
}

/** UTC midnight of `now`'s day — the earliest a sale may start. */
export function startOfDayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The budget month a sale is charged to — the month it STARTS in, so a window crossing a boundary costs
 * one month rather than two. UTC, not the creator's local time: the budget is enforced server-side and
 * has to give every caller the same answer. Near a boundary a creator can therefore see a sale land in
 * the month after the one their own calendar shows, which is why the UI names the month rather than
 * saying "this month".
 */
export function budgetMonthOf(startsAt: Date): Date {
  return new Date(Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth(), 1));
}

export type SaleEligibilityInput = {
  selectedCount: number;
  /** Selected versions gated as Early Access — a sale can't cover those. */
  earlyAccessCount: number;
  /**
   * Selected versions with no permanent access price. A sale composes over that price and nothing else,
   * so one laid over these covers a version and then discounts nothing anywhere (CU 868kwp6cx).
   */
  unpricedCount: number;
  creatorScore: number;
  tier: string | null | undefined;
  /** Sale-days already committed in the budget month the draft starts in. */
  daysUsedInMonth: number;
  draftDays: number;
  /** The discount as typed. Undefined until the creator has entered one. */
  amount: number | undefined;
  type: SaleDiscountType;
  /**
   * Cheapest buyer-facing price among covered versions — the floor a Fixed discount must stay under.
   * `null` means NONE ARE PRICED; `undefined` means NOT KNOWN, which blocks rather than waving through.
   */
  minCoveredPrice: number | null | undefined;
  /** Limits an operator has moved off the defaults, from the `sale-limits` KeyValue row. */
  overrides?: SaleLimitOverrides;
  startsAt: Date;
  now: Date;
  /** True while a server check the answer depends on is still in flight. */
  resolving: boolean;
};

export type SaleEligibility = {
  canSchedule: boolean;
  /** Selected versions a sale would actually apply to. */
  eligibleVersions: number;
  daysAllowed: number;
  daysLeft: number;
  /** Why the creator can't schedule this at all. Absent when they can. */
  blockedReason?: string;
  /** Set when the sale is schedulable but won't reach the whole selection. */
  partialNotice?: { skipped: number; applies: number };
};

// Named by what is wrong with the SELECTION, not by what the creator did: "nothing here is priced" is
// actionable, "sales need paid access" is a rule they then have to apply themselves.
const nothingPricedReason = (selectedCount: number) =>
  selectedCount === 1
    ? 'This version has no permanent access price, so a sale has nothing to take Buzz off.'
    : 'None of the selected versions has a permanent access price, so a sale has nothing to take Buzz off.';

const allEarlyAccessReason = (selectedCount: number) =>
  selectedCount === 1
    ? "This version is in early access, and a sale can't run on early access."
    : "Every selected version is in early access, and a sale can't run on early access.";

export function resolveSaleEligibility({
  selectedCount,
  earlyAccessCount,
  unpricedCount,
  creatorScore,
  tier,
  daysUsedInMonth,
  draftDays,
  amount,
  type,
  minCoveredPrice,
  overrides,
  startsAt,
  now,
  resolving,
}: SaleEligibilityInput): SaleEligibility {
  const eligibleVersions = Math.max(0, selectedCount - earlyAccessCount - unpricedCount);
  const daysAllowed = maxSaleDays(tier, overrides);
  const daysLeft = Math.max(0, daysAllowed - daysUsedInMonth);
  const leadDays = (startsAt.getTime() - now.getTime()) / DAY_MS;

  const minScore = minCreatorScoreForSale(overrides);
  const maxLead = maxSaleLeadDays(overrides);

  let blockedReason: string | undefined;
  if (creatorScore < minScore)
    blockedReason = `Sales unlock at a creator score of ${minScore.toLocaleString()}.`;
  else if (resolving) blockedReason = 'Checking which versions can go on sale…';
  // A floor we could not resolve is NOT "no floor". The preview can fail, and treating an unknown as
  // "nothing to clear" would offer Apply on a discount nothing has evaluated.
  else if (type === 'Fixed' && amount != null && minCoveredPrice === undefined)
    blockedReason = "Couldn't check the prices in your selection. Try again.";
  // Distinct from a refusal: an unset or backwards window is the creator mid-form, and telling them
  // their sale is too long when they have typed no dates reads as a bug in the form.
  else if (draftDays <= 0) blockedReason = 'Choose the days the sale runs.';
  else if (eligibleVersions <= 0)
    blockedReason =
      unpricedCount > 0 ? nothingPricedReason(selectedCount) : allEarlyAccessReason(selectedCount);
  else if (leadDays > maxLead) blockedReason = `A sale can start at most ${maxLead} days from now.`;
  // Backdating is not a cosmetic problem: the budget buckets by START month, so a sale backdated into a
  // past month spends an untouched budget and runs concurrently with this month's.
  else if (startsAt < startOfDayUtc(now)) blockedReason = "A sale can't start in the past.";
  else if (draftDays > daysLeft)
    blockedReason =
      daysLeft === 0
        ? 'You have no sale-days left for that month.'
        : `That sale is ${draftDays} days, and you have ${daysLeft} of ${daysAllowed} left for that month.`;
  // No sale may take a version to zero. A free purchase writes no Buzz transaction, and the 30-day
  // refund path reads amounts back from the ledger — so a zero-price purchase can't be refunded and
  // doesn't look like a sale happened at all. The check is against the CHEAPEST covered version, not
  // each one: a single "500 off" over versions at 500 and 2000 still zeroes the first.
  else if (amount != null && type === 'Percent' && amount > 99)
    blockedReason = 'A sale can take at most 99% off.';
  else if (
    amount != null &&
    type === 'Fixed' &&
    minCoveredPrice != null &&
    amount >= minCoveredPrice
  )
    blockedReason = `That would take the cheapest selected version (${minCoveredPrice} Buzz) to zero. Lower it, or clear the gate to give the model away.`;

  return {
    canSchedule: !blockedReason,
    eligibleVersions,
    daysAllowed,
    daysLeft,
    blockedReason,
    partialNotice:
      !blockedReason && earlyAccessCount + unpricedCount > 0
        ? { skipped: earlyAccessCount + unpricedCount, applies: eligibleVersions }
        : undefined,
  };
}

/** The form's raw value: calendar days, as the native date inputs give them. */
export type SaleDraftInput = {
  type: SaleDiscountType;
  amount: number | undefined;
  /** yyyy-mm-dd. */
  startDate: string;
  /** yyyy-mm-dd — the LAST day of the sale, inclusive. */
  endDate: string;
};

export type ResolvedSaleDraft = {
  startsAt: Date | null;
  /** Exclusive: midnight after the chosen last day, so "1st to the 3rd" is three days. */
  endsAt: Date | null;
  draftDays: number;
  budgetMonth: Date | null;
  daysUsedInMonth: number;
  eligibility: SaleEligibility;
};

/**
 * Days are chosen as calendar dates and resolved at UTC midnight, so the budget month is the same for
 * the creator, this form and the server. Reading them in local time would let one sale land in different
 * months either side of the request.
 */
export function dayToUtcMidnight(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function resolveSaleDraft(
  input: SaleDraftInput,
  ctx: {
    selectedCount: number;
    earlyAccessCount: number;
    unpricedCount: number;
    /** Cheapest buyer-facing price; null = none priced, undefined = not known (blocks). */
    minCoveredPrice: number | null | undefined;
    overrides?: SaleLimitOverrides;
    creatorScore: number;
    tier: string | null | undefined;
    /** The creator's existing sales. null = not loaded yet, which blocks scheduling (never treated as none). */
    sales: ModelVersionSaleWindow[] | null;
    resolving: boolean;
  },
  now: Date = new Date()
): ResolvedSaleDraft {
  const startsAt = dayToUtcMidnight(input.startDate);
  const lastDay = dayToUtcMidnight(input.endDate);
  const endsAt = lastDay ? new Date(lastDay.getTime() + DAY_MS) : null;
  const draftDays = startsAt && endsAt ? saleLengthInDays(startsAt, endsAt) : 0;
  const budgetMonth = startsAt ? budgetMonthOf(startsAt) : null;
  // saleDaysUsed is @civitai/buzz's, so the number shown here and the number the write refuses on are
  // computed by one function rather than two that can drift.
  const daysUsedInMonth = budgetMonth ? saleDaysUsed(ctx.sales, budgetMonth) : 0;

  return {
    startsAt,
    endsAt,
    draftDays,
    budgetMonth,
    daysUsedInMonth,
    eligibility: resolveSaleEligibility({
      selectedCount: ctx.selectedCount,
      earlyAccessCount: ctx.earlyAccessCount,
      unpricedCount: ctx.unpricedCount,
      creatorScore: ctx.creatorScore,
      tier: ctx.tier,
      daysUsedInMonth,
      draftDays,
      amount: input.amount,
      type: input.type,
      minCoveredPrice: ctx.minCoveredPrice,
      overrides: ctx.overrides,
      startsAt: startsAt ?? now,
      now,
      // A missing sale list is "not known", never "none used": an assumed-empty budget is a cap that
      // permits everything.
      resolving: ctx.resolving || ctx.sales === null,
    }),
  };
}

/**
 * The window a shorten may name: no earlier than now (or the start, for a sale that has not begun) and
 * at least one day before the current last day — the action stores `picked + 1 day`, so naming the
 * current last day reproduces today's end, which is not a shortening and is refused.
 *
 * A one-day sale therefore cannot be shortened at all; `possible` is false and the caller should offer
 * ending it instead of a control that can only fail.
 */
export function shortenBounds(
  sale: { startsAt: Date; endsAt: Date },
  now: Date
): { min: Date; max: Date; possible: boolean } {
  const currentLastDay = new Date(sale.endsAt.getTime() - DAY_MS);
  const max = new Date(currentLastDay.getTime() - DAY_MS);
  // 🔴 Compared as DAYS, not instants. `max` is midnight-aligned while `now` carries a time of day, so
  // an instant comparison calls a sale unshortenable from the moment its latest offerable day begins —
  // a two-day sale looks like a one-day sale at 09:00, the control disappears, and the creator is told
  // something false about their own sale. The picker renders both through `isoDay` anyway.
  const min = startOfDayUtc(new Date(Math.max(sale.startsAt.getTime(), now.getTime())));
  return { min, max, possible: max.getTime() >= min.getTime() };
}

export type SaleUndercut = {
  /** The sale is running now rather than still to come. */
  live: boolean;
  currentSalePrice: number;
  newPrice: number;
  newSalePrice: number;
  /** The new base price takes buyers below what the sale is already advertising. */
  undercuts: boolean;
};

/**
 * What a base-price edit does to a sale already scheduled over the version, if anything.
 *
 * A sale is an overlay, so the creator can move the base underneath one they set up days ago and are not
 * currently looking at. The discount itself is @civitai/buzz's — computing it here would be a second
 * implementation of the number buyers are charged.
 *
 * Returns null when no sale covers the version, or the price hasn't been changed to something usable.
 */
export function resolveSaleUndercut(
  {
    sales,
    storedPrice,
    newPrice,
  }: {
    sales: ModelVersionSaleWindow[] | undefined | null;
    storedPrice: number;
    newPrice: number | undefined;
  },
  now: Date = new Date()
): SaleUndercut | null {
  if (!sales?.length || newPrice == null || newPrice <= 0) return null;

  // The sale that would apply to the NEW price — for a fixed discount the best sale can differ between
  // two prices, so asking with the new one is what makes the quoted figure the one buyers will see.
  const sale = bestSaleFor(newPrice, sales, now) ?? upcoming(sales, now);
  if (!sale) return null;

  const newSalePrice = newPrice - saleDiscountFor(newPrice, sale);
  // The sale that applies TODAY is chosen against today's price. With a fixed and a percentage sale
  // overlapping, the deepest one differs between the two prices, so reusing the new price's winner
  // would quote a "currently" figure no buyer is paying.
  const current = bestSaleFor(storedPrice, sales, now) ?? sale;
  const currentSalePrice =
    storedPrice > 0 ? storedPrice - saleDiscountFor(storedPrice, current) : 0;

  return {
    live: isSaleActive(sale, now),
    currentSalePrice,
    newPrice,
    newSalePrice,
    // Strictly below: pricing exactly at the sale price is a creator matching it deliberately.
    undercuts: currentSalePrice > 0 && newSalePrice < currentSalePrice,
  };
}

/** The soonest sale that hasn't started yet — bestSaleFor only considers windows already open. */
function upcoming(sales: ModelVersionSaleWindow[], now: Date): ModelVersionSaleWindow | undefined {
  return sales
    .filter((s) => s.startsAt > now && s.canceledAt == null)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
}
