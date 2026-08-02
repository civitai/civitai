import * as z from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// The Civitai-hosted image-URL bound, shared by EVERY App Blocks wire surface
// that accepts an image URL from an untrusted iframe.
//
// 🔴 WHY THIS IS ITS OWN MODULE. This rule originally lived inline in
// `workflow.schema.ts` (as `blockSourceImageSchema`'s `url` field) because
// `textToImage` was the only member that took an image. The `kind: 'step'`
// registry adds a SECOND class of consumer (`convertImage`, and every future
// image-taking step type), and the registry cannot import `workflow.schema.ts`
// — that module imports the registry to derive its wire enums, so the
// dependency would be a cycle. Copying the rule into the registry instead would
// give the same predicate two homes, which is how one copy gets a fix and the
// other doesn't. So it lives here, imported by both, with zero local imports of
// its own (client-safe: `workflow.schema.ts` is `import type`'d by a client
// component, so this module must stay free of server-only imports).
//
// The rule itself is UNCHANGED from the inline version — the extraction is a
// move, not a rewrite. Its reasoning, preserved:
//
// An init/source image MUST NOT be an arbitrary remote URL the generator would
// fetch (SSRF / arbitrary-fetch). It is bounded to a Civitai-controlled host.
// An uploaded image resolves to an `https://orchestration…civitai.com` URL, so
// this same bound covers the "uploaded image" case WITHOUT widening to
// attacker-controlled origins.
//
// This is validated by parsed URL HOSTNAME (not a substring match), which is
// intentionally tighter than the platform's server `sourceImageSchema`
// (`.includes('image.civitai.com')`) — a substring check would accept
// `https://evil.example/?x=image.civitai.com`; a hostname check rejects it and
// also rejects non-https and userinfo.
//
// 🔴 A hostname check ALONE is not sufficient, because it validates a PARSED
// url while the schema used to emit the ORIGINAL string. Every consumer
// downstream then re-parses those original bytes, and a parser that disagrees
// with WHATWG about them sees a DIFFERENT host than the one we approved. Two
// concrete WHATWG-specific behaviours were being relied on as security
// properties, both verified to pass the bare hostname check:
//   - backslash-in-authority: WHATWG treats a backslash as a slash for special
//     schemes, so an authority of `civitai.com` + backslash + `@evil.com`
//     parses with host `civitai.com`. A parser that splits the authority on the
//     last `@` without treating the backslash as a delimiter reads
//     host = `evil.com`.
//   - TAB / CR / LF deletion: WHATWG strips those three bytes from ANYWHERE in
//     the url, so `evil.com` + CRLF + `.civitai.com` normalizes to the
//     (nonexistent) subdomain `evil.com.civitai.com` and passes — while the raw
//     string, CRLF intact, is what got forwarded. CRLF inside a value a
//     consumer concatenates into a request line or header is a
//     request-splitting / log-injection primitive.
// So the bound is enforced in three layers, in this order:
//   1. REJECT ambiguous bytes before parsing. No legitimate url carries a raw
//      backslash or control byte — they must be percent-encoded — so this costs
//      nothing, and it closes the differential class at the door rather than
//      silently rewriting a plainly hostile input into an accepted one.
//   2. Validate the parsed hostname.
//   3. CANONICALIZE to `URL.href`, so the bytes we emit are exactly the bytes
//      we validated. This also covers normalization classes beyond the bytes
//      above (percent-encoding, default-port stripping, empty-path, host
//      case-folding).
// ─────────────────────────────────────────────────────────────────────────────

export const CIVITAI_IMAGE_HOSTS = ['civitai.com', 'civitai.red', 'civitai.green'] as const;

/** Backslash. */
const CHAR_BACKSLASH = 0x5c;
/** Highest C0 control code point. */
const CHAR_C0_MAX = 0x1f;
/** DEL. */
const CHAR_DEL = 0x7f;

/**
 * True when the string carries a backslash, a C0 control, or DEL — a superset
 * of the TAB/CR/LF bytes WHATWG deletes and the leading/trailing C0 it strips,
 * so no byte the parser silently removes or reinterprets can survive into the
 * value we approve.
 *
 * Written as a code-point scan rather than the equivalent character-class
 * regex on purpose: that class needs stacked backslash escapes to express, and
 * a security predicate whose meaning hinges on escaping is exactly the literal
 * that gets silently corrupted in transit and still compiles. (It did, while
 * this file was being written: the escapes were resolved into RAW control bytes
 * embedded in the source, which reads identically in an editor, still parses,
 * and quietly changes what the class matches.)
 */
export function hasUrlAmbiguousBytes(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code === CHAR_BACKSLASH || code <= CHAR_C0_MAX || code === CHAR_DEL) return true;
  }
  return false;
}

// Bound applies to BOTH the raw input and the canonicalized output: percent-
// encoding can inflate a string ~9x (a 2048-char path of CJK canonicalizes to
// 18272 chars), so the pre-transform cap does NOT bound what we emit.
export const SOURCE_IMAGE_URL_MAX = 2048;

export function isCivitaiHostedImageUrl(raw: string): boolean {
  if (hasUrlAmbiguousBytes(raw)) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return CIVITAI_IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * The reusable bounded-and-canonicalized Civitai image URL string schema.
 *
 * Order is load-bearing. A `.transform()` that THROWS propagates out of
 * `safeParse` (it does not become a parse failure) — so `new URL()` here must
 * be total. Zod skips the transform entirely when an earlier check on the same
 * string failed (verified against zod 4), so by the time it runs, the refine
 * above has already proven the string parses. Do not reorder these.
 */
export const civitaiHostedImageUrlSchema = z
  .string()
  .max(SOURCE_IMAGE_URL_MAX)
  .refine(isCivitaiHostedImageUrl, 'source image must be a Civitai-hosted https image URL')
  .transform((raw) => new URL(raw).href)
  .refine(
    (href) => href.length <= SOURCE_IMAGE_URL_MAX,
    'source image URL exceeds the maximum length once canonicalized'
  );
