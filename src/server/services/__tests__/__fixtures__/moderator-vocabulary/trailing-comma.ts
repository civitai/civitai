// A fixture for `moderator-restriction-vocabulary.test.ts`, NOT a copy of anything shipped.
//
// A trailing comma after the last entry — what Prettier writes the moment either list grows past
// the print width.
export const RESTRICTION_TYPES = ['generation', 'bot-account', 'spam-account',] as const;

export const RULINGS_WIRED_FOR: readonly string[] = ['generation', 'bot-account',];

export function unwiredRulingReason(type: string): string | null {
  return (RULINGS_WIRED_FOR as readonly string[]).includes(type)
    ? null
    : `Rulings are not yet available for "${type}" restrictions — the verdict path still sends generation-specific notices. This restriction was NOT resolved.`;
}
