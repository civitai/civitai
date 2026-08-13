import {
  licensingFeeBlockedFor,
  paidAccessBlockedFor,
  type MonetizationSubject,
} from '@civitai/buzz';

/** Everything one version write can charge for. Shapes are the caller's; this only ever nulls them. */
export type VersionCharges<TGate, TGoal, TMonetization> = {
  paidAccess?: TGate | null;
  donationGoal?: TGoal | null;
  monetization?: TMonetization | null;
  licensingFee?: number | null;
};

/**
 * Apply the model-level monetization rules to one version write, returning what may actually be saved.
 *
 * Separate from the write itself so the two orderings that matter are testable: a stripped charge must
 * not still count as monetizing (the rights affirmation is keyed to that, and demanding an affirmation
 * for a charge that is being removed makes the version unsavable), and a donation goal must leave with
 * the gate it funds rather than outliving it.
 */
export function applyModelMonetizationPolicy<TGate, TGoal, TMonetization>(
  model: MonetizationSubject,
  charges: VersionCharges<TGate, TGoal, TMonetization>
): {
  paidAccess: TGate | null | undefined;
  donationGoal: TGoal | null | undefined;
  monetization: TMonetization | null | undefined;
  licensingFee: number | null | undefined;
  /** True when the fee columns must be written as NULL, including when the caller sent no fee at all. */
  clearFee: boolean;
  /**
   * Whether a per-generation fee survives the rules. The caller ORs this with whether the surviving gate
   * charges; what matters here is that a stripped fee stops counting, because the rights-affirmation gate
   * reads it and a version cannot affirm its way out of a charge that is being removed.
   */
  feeMonetizes: boolean;
} {
  const gateBlocked = paidAccessBlockedFor(model);
  const feeBlocked = licensingFeeBlockedFor(model);

  const paidAccess = gateBlocked ? null : charges.paidAccess;
  const donationGoal = gateBlocked ? null : charges.donationGoal;
  const monetization = feeBlocked ? null : charges.monetization;
  const licensingFee = feeBlocked ? null : charges.licensingFee;

  return {
    paidAccess,
    donationGoal,
    monetization,
    licensingFee,
    clearFee: feeBlocked,
    feeMonetizes: licensingFee != null && licensingFee > 0,
  };
}
