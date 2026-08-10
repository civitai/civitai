// The closed lists the enforcement forms offer, in a module BOTH the panels and the action schemas can
// import. The services in `$lib/server` own the same values but a component cannot import from there,
// so each list was being re-typed in the panel — and the ban list is the one that must not drift: it
// mirrors the main app's `BanReasonCode`, which `/api/mod/ban-user` parses strictly. A code added
// server-side is then silently missing from the dropdown; one added only here 500s the ban.

export const BAN_REASONS = [
  'SexualMinor',
  'SexualMinorGenerator',
  'SexualMinorTraining',
  'SexualPOI',
  'Bestiality',
  'Scat',
  'Nudify',
  'Harassment',
  'LeaderboardCheating',
  'BuzzCheating',
  'RRDViolation',
  'Other',
] as const;

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

// The full ledger enum stays for the SERVER's zod check: it mirrors `BUZZ_TRANSACTION_TYPES` in
// user-actions.service.ts, which owns the numeric values the buzz API wants.
export const BUZZ_TRANSACTION_TYPES = [
  'Compensation',
  'Reward',
  'Refund',
  'ChargeBack',
  'Appeal',
  'Tip',
  'Dues',
  'Generation',
  'Boost',
  'Incentive',
  'Purchase',
  'AuthorizedPurchase',
  'Bounty',
  'BountyEntry',
  'Training',
  'Donation',
  'ClubMembership',
  'ClubMembershipRefund',
  'ClubWithdrawal',
  'ClubDeposit',
  'Withdrawal',
  'Redeemable',
  'Sell',
  'Bank',
  'Extract',
  'Fee',
  'Bid',
  'LicenseFee',
] as const;

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
