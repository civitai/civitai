// A fixture for `moderator-restriction-vocabulary.test.ts`, NOT a copy of anything shipped.
//
// 🔴 The case NO text parse can reach, at any regex width: neither list is written as a literal at
// its own declaration, and the refusal message is assembled rather than templated. A reader that
// EXECUTES the module sees the real values; a reader that reads the file as text sees
// `'generation', ...RULINGS_ADDED_LATER` and a `return` with no backtick in it.
//
// 🔴 "Assembled at runtime" here means ASSEMBLED FROM CONSTANTS DECLARED IN THIS FILE, which is the
// same value in every environment — that is what the execute reader is entitled to certify, and all
// this fixture sanctions. It does NOT sanction a value read from the ENVIRONMENT
// (`import.meta.env`, `process.env`): the reader executes the module in the main app's test process,
// so such a value is resolved under Vitest and never under the moderator app's production build.
// That shape is refused by name — see `assertEnvironmentIndependent` in the harness.
const RULINGS_ADDED_LATER = ['bot-account'];
const REFUSAL_TAIL =
  ' restrictions — the verdict path still sends generation-specific notices. This restriction was NOT resolved.';

export const RESTRICTION_TYPES = ['generation', ...RULINGS_ADDED_LATER, 'spam-account'] as const;

export const RULINGS_WIRED_FOR: readonly string[] = ['generation', ...RULINGS_ADDED_LATER];

export function unwiredRulingReason(type: string): string | null {
  if ((RULINGS_WIRED_FOR as readonly string[]).includes(type)) return null;
  return 'Rulings are not yet available for "' + type + '"' + REFUSAL_TAIL;
}
