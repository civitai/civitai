/**
 * The error-bounding wrapper shared by the manifest declaration parsers
 * (`parseManifestAnalytics`, `parseManifestStorage`). Pure, client-safe, no imports.
 *
 * Every such parser makes the same three promises, and this is the one place they are kept:
 *
 * - **Total.** A throw inside `parse` (reachable only via a throwing getter or a Proxy —
 *   JSON input cannot get there) becomes the single error `<noun> could not be read`.
 * - **All or nothing.** When there is any error the caller's `invalid` builds the result,
 *   so it can return an empty declaration rather than part of one.
 * - **Bounded.** At most `maxErrors` messages, then one summary line
 *   `…and N more <noun> errors`. The errors are joined into the submit response, so without
 *   a cap a crafted manifest becomes a multi-megabyte error message.
 *
 * `invalid` receives the parse result when there was one (`undefined` after a throw), so a
 * caller can carry forward fields that stay meaningful on failure.
 */
export function boundedManifestParse<R extends { errors: string[] }>(opts: {
  noun: string;
  maxErrors: number;
  parse: () => R;
  invalid: (errors: string[], parsed: R | undefined) => R;
}): R {
  let parsed: R;
  try {
    parsed = opts.parse();
  } catch {
    return opts.invalid([`${opts.noun} could not be read`], undefined);
  }
  if (parsed.errors.length === 0) return parsed;
  const capped = parsed.errors.slice(0, opts.maxErrors);
  const rest = parsed.errors.length - capped.length;
  if (rest > 0) capped.push(`…and ${rest} more ${opts.noun} errors`);
  return opts.invalid(capped, parsed);
}
