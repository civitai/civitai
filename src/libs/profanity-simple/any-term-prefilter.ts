import type { RegExpMatcher } from 'obscenity';

// obscenity keeps these private; read them so the prefilter runs the matcher's own regexes on its
// own transformed text.
type MatcherInternals = {
  blacklistedTerms: { regExp: RegExp }[];
  blacklistMatcherTransformers: unknown;
  applyTransformers(input: string, transformers: unknown): [number[], string];
};

function readInternals(matcher: RegExpMatcher): MatcherInternals | null {
  const m = matcher as unknown as Partial<MatcherInternals>;
  if (!Array.isArray(m.blacklistedTerms) || typeof m.applyTransformers !== 'function') return null;
  if (m.blacklistMatcherTransformers == null) return null;
  // A backreference would point at another term's group once the sources are joined.
  const sameFlags = (term: { regExp?: unknown }) =>
    term?.regExp instanceof RegExp &&
    term.regExp.flags === 'gs' &&
    !/\\[1-9]|\\k</.test(term.regExp.source);
  if (!m.blacklistedTerms.every(sameFlags)) return null;
  return m as MatcherInternals;
}

/**
 * Tells whether any blocked term can match `text`, in one regex scan instead of one per term.
 * Only a `false` is acted on (no matches at all), so `getAllMatches` still decides every text
 * this flags, and the output is the per-term pass's by construction. One pass cannot replace
 * it: the per-term pass reports overlapping matches of different terms, which a single
 * alternation, consuming the leftmost, would drop.
 *
 * `null` when obscenity's internals are not the shape this reads (a dependency bump) or the
 * alternation will not compile: callers then run the per-term pass on everything, slower but
 * the same answer. Any later surprise answers `true` for the same reason.
 */
export function createAnyTermPrefilter(matcher: RegExpMatcher): ((text: string) => boolean) | null {
  const internals = readInternals(matcher);
  if (!internals || internals.blacklistedTerms.length === 0) return null;
  const mayMatch = (text: string, anyTerm: RegExp) => {
    const [, transformed] = internals.applyTransformers(
      text,
      internals.blacklistMatcherTransformers
    );
    return typeof transformed === 'string' ? anyTerm.test(transformed) : true;
  };
  let anyTerm: RegExp;
  try {
    // No 'g' flag: with it, test() would keep lastIndex between calls.
    anyTerm = new RegExp(
      internals.blacklistedTerms.map(({ regExp }) => `(?:${regExp.source})`).join('|'),
      's'
    );
    // V8 compiles a regex on first use: run it once here, so a size limit or a changed
    // internal fails now, into the fallback, rather than inside every clean().
    mayMatch('a probe', anyTerm);
  } catch {
    return null;
  }
  return (text) => {
    try {
      return mayMatch(text, anyTerm);
    } catch {
      return true;
    }
  };
}
