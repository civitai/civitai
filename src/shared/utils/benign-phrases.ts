// Client-safe half of the moderator benign-phrase machinery. The server copy lives in
// `blocklist.service`, which pulls in Prisma and Redis and therefore cannot be imported
// from a component — the search gates run in the browser, so the matcher has to live here.

const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Compile a moderator-managed phrase list into a single whole-word, case-insensitive
// matcher. Whitespace in a phrase is loosened so "teen titans" also matches "teen  titans" /
// "teen-titans" / "teen.titans". Zero-width alnum boundaries (matching audit.ts) instead of
// `\b` so a phrase whose edge is punctuation still anchors. Returns null for an empty list so
// callers can skip the replace.
//
// The separator is BOUNDED at {1,3}, as audit.ts bounds its own quantifiers. Unbounded means
// opposite things either side of this: for a DETECTOR, matching across a long run of junk
// blocks more, which is safe; for a WHITELIST it strips more, so an unbounded run between the
// words of a phrase can swallow text the next check still needed to see.
export function buildBenignPhraseRegex(phrases: string[]): RegExp | null {
  const cleaned = phrases.map((p) => p.trim()).filter((p) => p.length > 0);
  if (!cleaned.length) return null;
  const alternation = cleaned
    .map((p) => escapeRegex(p).replace(/\s+/g, '[^a-zA-Z0-9]{1,3}'))
    .join('|');
  return new RegExp(`(?<![a-zA-Z0-9])(?:${alternation})(?![a-zA-Z0-9])`, 'gi');
}

/** Synchronous counterpart to the server's `stripBenignPhrases`, for an already-fetched list. */
export function stripBenignPhrasesWith(text: string | undefined, pattern: RegExp | null) {
  if (!text || !pattern) return text ?? '';
  return text.replace(pattern, ' ');
}
