/**
 * Strip every occurrence of each known value from a value, via its JSON serialization.
 *
 * KNOWN-VALUE redaction (strip these exact strings), for the recurring situation where a
 * third-party endpoint echoes our submitted payload back in an error and that error is
 * about to become log content.
 *
 * 🔴 Takes a LIST, and the caller passes every value actually in use. For the media-ingest
 * route that means the callback URL in play rather than just `WEBHOOK_TOKEN`: the callback is
 * `env.IMAGE_SCANNING_CALLBACK` whenever that is set (production takes that branch), and if
 * the override carries its own secret query param then splitting on `WEBHOOK_TOKEN` strips
 * nothing while looking like it worked.
 *
 * 🔴 Redacts a whole value, not one field — a validation-error payload that echoes submitted
 * fields carries them wherever it likes.
 *
 * 🔴 Two mechanics are load-bearing and each was a bug in a hand-rolled copy:
 *  - **The JSON-escaped form as well as the raw one.** A needle containing a character JSON
 *    escapes (`"`, `\`, a control char) never appears raw in the serialized string, so a
 *    raw-only split silently redacts nothing. User prompts routinely contain quotes and
 *    newlines, so this is the common case rather than the exotic one.
 *  - **Longest needle first.** Otherwise a short needle that is a substring of a long one
 *    fires first, the long needle then matches nothing, and the rest of it survives. (A
 *    `baseModel` of `pony` against a prompt of `a pony in a field` is exactly that shape.)
 * `split`/`join`, never a regex — a needle may carry regex metacharacters.
 *
 * ⚠ The repo also has PATTERN redaction in `~/utils/faro/redact.ts` (`redactUrl`,
 * `deepRedact`), which strips any sensitively-named query param on any embedded URL without
 * knowing the value — so it still catches a secret the third party re-serializes (param
 * reorder, re-encoding) where a whole-URL needle would miss. They are complementary, not
 * substitutes: a bare token not inside a URL is only caught here. Deliberately not composed,
 * because `deepRedact` carries Faro-specific tuning.
 *
 * 🔴 This module exists because a THIRD copy was about to be written. It lived in
 * `src/pages/api/media/ingest/[mediaId].ts` and that file's comment asked the next caller to
 * reach for a shared module rather than grow another facility; `services/ai/jev.ts` is that
 * next caller. If you need a fourth, import this — do not re-derive the two mechanics above.
 */
export function redactKnownValues<T>(value: T, knownValues: Array<string | undefined>): T {
  if (value == null) return value;
  const needles = knownValues
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .sort((a, b) => b.length - a.length);
  if (!needles.length) return value;

  const strip = (text: string) => {
    let out = text;
    for (const known of needles) {
      // Both forms, because the caller does not know which one the third party
      // used: a value echoed inside a JSON field arrives escaped, the same value
      // echoed in a plain-text message arrives raw.
      for (const needle of new Set([known, JSON.stringify(known).slice(1, -1)])) {
        out = out.split(needle).join('<redacted>');
      }
    }
    return out;
  };

  // 🔴 A STRING is redacted DIRECTLY, with no serialize/parse round trip. Running
  // `JSON.stringify` over a value that is ALREADY a JSON document escapes it a
  // SECOND time, so the needle — raw or once-escaped — matches neither form and
  // the redaction silently does nothing. That is exactly the shape of the caller
  // this module was extracted for: `services/ai/jev.ts` hands it the raw bytes of
  // a JSON error body. Found by the delta review round, after the first version
  // of that fix shipped a test whose prompt contained nothing escapable.
  if (typeof value === 'string') return strip(value) as unknown as T;

  try {
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    return JSON.parse(strip(json)) as T;
  } catch {
    return '<redacted>' as unknown as T;
  }
}
