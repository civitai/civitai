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

export const BUZZ_TRANSACTION_TYPES = ['compensation', 'reward', 'refund', 'chargeback'] as const;
