// Page-local: the picker renders these, and a component importing `$lib/server/*` would drag the
// database client into the client bundle. Mirrors `BAN_REASON_CODES` in user-actions.service.ts.
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
