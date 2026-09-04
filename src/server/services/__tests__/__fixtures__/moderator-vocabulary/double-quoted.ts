// A fixture for `moderator-restriction-vocabulary.test.ts`, NOT a copy of anything shipped.
//
// Double-quoted entries. The old text parser extracted `/'([^']+)'/g` only, so a file Prettier had
// been configured to double-quote read as an EMPTY list on both counts.
export const RESTRICTION_TYPES = ["generation", "bot-account", "spam-account"] as const;

export const RULINGS_WIRED_FOR: readonly string[] = ["generation", "bot-account"];

export function unwiredRulingReason(type: string): string | null {
  return RULINGS_WIRED_FOR.includes(type)
    ? null
    : `Rulings are not yet available for "${type}" restrictions — the verdict path still sends generation-specific notices. This restriction was NOT resolved.`;
}
