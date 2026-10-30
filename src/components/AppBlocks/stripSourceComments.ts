/**
 * Strip JS/TS comments from a source string, without stripping comment-shaped
 * text that lives inside a string or template literal.
 *
 * WHY THIS IS A SCANNER AND NOT A REGEX. Two source-grep guards in this
 * directory (`hostHandlerParity.test.ts`, `blockStorageCacheParity.test.ts`)
 * assert that a call is REGISTERED in a host. Both are defeated if a
 * commented-out call still reads as present, so both must strip comments first.
 * Two successive regex attempts each failed in one direction, and each failure
 * was found by an adversarial audit rather than by review:
 *
 *   unanchored line-comment rule — stripped commented-out calls correctly, but
 *                                 also TRUNCATED real code containing `//`,
 *                                 e.g. an open-redirect guard's
 *                                 `cleaned.includes('//')` condition.
 *   line-start-anchored rule    — stopped truncating real code, but REOPENED
 *                                 the walk-past for a trailing comment:
 *                                 `void 0; // await invalidate…` survived, and
 *                                 the guard went green with the call gone.
 *
 * The second is the dangerous direction: it is the exact shape a prior audit
 * used to walk one of these guards, on the host that guard is the only coverage
 * for. `//` inside a string literal is the whole difficulty, so the fix is to
 * track quote state — which a regex cannot do.
 *
 * Scope, stated honestly: this handles line comments, block comments, the three
 * string-literal forms and backslash escapes. It does NOT parse regex literals,
 * so `/ /` division-vs-regex ambiguity is out of scope — a `//` inside a regex
 * literal would still be treated as a comment. No such construct exists in the
 * files these guards read, and the failure direction there is an over-strip
 * (spurious FAILURE, investigated by a human) rather than invented coverage.
 */
export function stripSourceComments(src: string): string {
  let out = '';
  let i = 0;
  // Which literal we are inside, if any.
  let quote: '"' | "'" | '`' | null = null;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (quote) {
      if (c === '\\') {
        // Escape: copy the pair verbatim so `\'` cannot close the literal.
        out += c + (next ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }

    if (c === '/' && next === '/') {
      // Line comment: drop to (but keep) the newline, so line numbers and the
      // line-oriented assertions above this module stay aligned.
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }

    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        // Preserve newlines so the stripped source keeps its line structure.
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}
