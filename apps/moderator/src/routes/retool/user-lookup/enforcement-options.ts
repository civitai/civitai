// Page-local option sets. Anything a SERVICE also needs lives in `$lib/enforcement` instead — a list
// declared in both places is one that drifts.

export const LINK_TYPES = ['Social', 'Sponsorship', 'Other'] as const;

/** Retool's `presetMutes`. */
export const MUTE_PRESETS: [number, string][] = [
  [6, '6h'],
  [12, '12h'],
  [24, '24h'],
  [48, '48h'],
  [72, '72h'],
  [168, '1 week'],
];

export const REWARDS_ELIGIBILITY: [string, string][] = [
  ['Ineligible', 'Add Buzz-Block'],
  ['Eligible', 'Remove Buzz-Block'],
  ['Protected', 'Generator Buzz Earnings'],
];

export const PROFILE_FIELDS = [
  ['bio', 'Bio'],
  ['message', 'Profile message'],
  ['location', 'Location'],
] as const;

// Retool's "Reason" picker is SCOPED BY ACTION — `buzzSendType.data` is
// `{{buzzSendAction.value === 'send' ? SendTypes.value : DeductTypes.value}}`, two Functions holding
// these five entries. Offering the full ledger enum in both directions makes `deduct + Reward`
// selectable, which is not a transaction anyone means to file. The `Deduct Types` reference table
// beside the form documents exactly these three deduct types, which is the corroborating tell.
//
// Widening either list is a decision for the mod team, not a default — see the backlog.
export const BUZZ_SEND_REASONS = ['Reward', 'Refund'] as const;
export const BUZZ_DEDUCT_REASONS = ['Purchase', 'ChargeBack', 'AuthorizedPurchase'] as const;

/** Retool's `buzzSendEntityType` — a closed list, not free text. */
export const BUZZ_ENTITY_TYPES = ['Collection', 'Image', 'Model'] as const;

/** Retool's `buzzSendAction` labels. */
export const BUZZ_ACTIONS: [string, string][] = [
  ['send', 'Send Buzz to User'],
  ['deduct', 'Deduct Buzz from User'],
];

/** Retool's `buzzType`. */
export const BUZZ_COLORS: [string, string][] = [
  ['yellow', 'Yellow Buzz'],
  ['blue', 'Blue Buzz'],
  ['green', 'Green Buzz'],
];
