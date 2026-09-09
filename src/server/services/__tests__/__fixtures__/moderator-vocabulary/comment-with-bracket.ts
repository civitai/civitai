// A fixture for `moderator-restriction-vocabulary.test.ts`, NOT a copy of anything shipped.
//
// 🔴 The MEASURED walk-through from the #4609 round-2 audit. A `]` inside a trailing comment ends
// the old text parser's `[^\]]*` capture, so it read only the first entry of each list and reported
// the two apps as agreeing while they did not. Nothing here is hostile — a comment naming an index
// is ordinary prose.
export const RESTRICTION_TYPES = [
  'generation', // matches RESTRICTION_TYPES[0] in the main app
  'bot-account',
  'spam-account',
] as const;

export const RULINGS_WIRED_FOR: readonly string[] = [
  'generation', // the only one the main app agrees about — RULINGS_WIRED_FOR[0]
  'bot-account',
];

export function unwiredRulingReason(type: string): string | null {
  return (RULINGS_WIRED_FOR as readonly string[]).includes(type)
    ? null
    : `Rulings are not yet available for "${type}" restrictions — the verdict path still sends generation-specific notices. This restriction was NOT resolved.`;
}
