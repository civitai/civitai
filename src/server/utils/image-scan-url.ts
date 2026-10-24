import { isValidCivitaiImageUrl } from '~/utils/article-helpers';
import { hasUrlAmbiguousBytes } from '~/server/schema/blocks/civitai-image-url';
import { isEdgeUrlPassthrough } from '~/shared/utils/edge-url-passthrough';

/**
 * Allowlist for the URLs the image-scan ingestion may be pointed at.
 *
 * The orchestrator fetches `mediaUrl` server-side from inside the cluster, so any
 * caller-controlled absolute URL that reaches `Image.url` is an SSRF primitive: the
 * comics procs, article content media nodes and several other paths pass raw client
 * URLs into `createImage`, and `getEdgeUrl` forwards absolute `http(s)`/`blob:` URLs
 * through UNMODIFIED (edge-url.ts). A genuine relative CF UUID key is prefixed with
 * `NEXT_PUBLIC_IMAGE_LOCATION` before submission, so it is allowed outright — but it
 * must be checked to BE relative rather than merely "not something getEdgeUrl forwards",
 * because that env var defaults to `''` and an empty prefix is dropped.
 *
 * Absolute URLs must be one of:
 *  - our storage hosts (`isValidCivitaiImageUrl`: image.civitai.com + subdomains,
 *    civitai.com, wasabisys.com, civitai-prod.s3.amazonaws.com);
 *  - the OAuth avatar hosts actually present in `Image` data. These are checked as
 *    HOST+PATH PREFIXES, not bare hosts: `cdn.discordapp.com` also serves arbitrary
 *    user-uploaded `/attachments/…` files, so a bare-host check would let a submit
 *    point the scanner at attacker-chosen content on a real CDN. 🔴 The prefix test runs
 *    against the NORMALIZED href — against the raw string it does not deliver that, since
 *    `…/avatars/../attachments/x` passes it and resolves elsewhere. The same prefix list
 *    guards avatar updates in user.controller — keep the two identical.
 *
 * 🔴 KNOWN RESIDUAL, inherited from `isValidCivitaiImageUrl` and NOT closed here. It is
 * wider than a redirect problem, and the obvious narrowing does NOT fix it:
 *
 *  - `wasabisys.com` matches as a bare SUFFIX, and Wasabi bucket names are a self-service
 *    GLOBAL namespace, so `https://<attacker-bucket>.s3.wasabisys.com/evil.png` is admitted
 *    outright — attacker-chosen content straight to the scanner, NO redirect required.
 *    (A redirect leg on an allowlisted host is an additional, separate hazard, and whether
 *    it is reachable depends on the orchestrator following redirects, which cannot be
 *    settled from this repo.)
 *  - 🔴 Pinning "the exact legacy bucket hosts" is NOT sufficient, because our legacy form
 *    is PATH-style (`https://s3.us-west-1.wasabisys.com/civitai-prod/images/…`, see
 *    packages/civitai-db-schema/prisma/seed.ts and the `images.remotePatterns` list in
 *    next.config.mjs). Pinning that host still admits
 *    `https://s3.us-west-1.wasabisys.com/<attacker-bucket>/evil.png`. It needs HOST + PATH
 *    PREFIX — exactly the rule derived above for `cdn.discordapp.com`. The asymmetry is the
 *    bug: the multi-tenant-CDN rule was not applied to a multi-tenant OBJECT STORE.
 *  - `civitai.com` is likewise admitted with no path, PORT or scheme restriction, so every
 *    existing `*.civitai.com` name on ANY port with ANY path is an allowlist entry —
 *    including any subdomain ever CNAMEd to a third-party SaaS, and any internal service
 *    reachable on a non-standard port. An attacker cannot mint such a name, so this is a
 *    constrained rather than open SSRF, but it is the same class as the suffix issue above.
 *
 * Why it is not fixed in this change: `isValidCivitaiImageUrl` is SHARED with article
 * validation, so tightening it there changes unrelated behaviour, and a wrong rejection
 * HERE is permanent — `markImageScanSubmitFailure` at status 400 stamps `ingestion=Error`
 * with a retry ceiling of 1. Narrowing safely needs the real distribution of
 * `Image.url` wasabi shapes first.
 *
 * `blob:` is rejected outright: it is never fetchable server-side, so a blob URL can
 * only produce a guaranteed-failed workflow (this is what the failed submits that
 * carried `blob:` URLs were doing).
 *
 * Deliberately NO env-derived host here: this module is imported into orchestrator
 * service's graph, and suites that mock `~/client-utils/edge-url` do so specifically
 * to keep the real `~/env/client` (which throws on validation) out of their worker.
 * Importing env here would re-introduce it behind their backs.
 */
export const AVATAR_URL_PREFIXES = [
  'https://cdn.discordapp.com/avatars/',
  'https://cdn.discordapp.com/embed/avatars/',
  'https://avatars.githubusercontent.com/u/',
  'https://lh3.googleusercontent.com/a/',
] as const;

export class ImageIngestionUrlBlockedError extends Error {
  constructor(readonly url: string) {
    super(`Image url is not on the ingestion allowlist: ${url}`);
    this.name = 'ImageIngestionUrlBlockedError';
  }
}

/**
 * A `:` before the first `/` — i.e. a scheme. `/` is outside the character class on
 * purpose, so a colon inside a filename (`<uuid>/my:file.png`) is not a scheme.
 */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 🔴 Is the authority of this raw string PARSER-DEPENDENT?
 *
 * We judge the host with WHATWG `new URL()`; the orchestrator fetches with an RFC-3986
 * client. The two disagree when a `\` precedes an `@`: WHATWG folds `\` to `/`, so the
 * authority ends at it, while RFC parsers read it as userinfo, so the authority ends at
 * the `@`. MEASURED on `https://image.civitai.com\@127.0.0.1:6379/x` — Node reports
 * hostname `image.civitai.com` (which this allowlist would admit), Python `urlsplit`
 * reports `127.0.0.1:6379`, and `curl` connects to 127.0.0.1. Explicit userinfo is the
 * same hazard spelled openly, and `assertSafeMediaUrls` in training.service.ts already
 * refuses it.
 *
 * Rejecting these is what makes the host we validated the host that gets fetched.
 */
function hasAmbiguousAuthority(parsed: URL, raw: string): boolean {
  // `hasUrlAmbiguousBytes` is this repo's existing, tested spelling of the raw-string half,
  // and it is strictly WIDER than a backslash test: it refuses every C0 control and DEL too,
  // which covers the TAB/CR/LF-deletion variant of the same differential. Reused rather than
  // re-derived — that module's docblock records the same measurement as this one.
  return hasUrlAmbiguousBytes(raw) || !!parsed.username || !!parsed.password;
}

/**
 * Is this an allowed AVATAR url?
 *
 * 🔴 Exported so `verifyAvatar` (user.controller) and the ingestion allowlist share the
 * PREDICATE, not merely the list. Sharing only `AVATAR_URL_PREFIXES` was not enough: each
 * side open-coded the test that applies it, so when this side hardened to the normalized
 * href, `verifyAvatar` stayed on the raw string and `…/avatars/../attachments/x` was refused
 * here while still being ACCEPTED there — the arbitrary-upload surface the prefix list
 * exists to exclude, reachable through the avatar path.
 *
 * ⚠ It returns a BOOLEAN about a raw string whose `href` may differ from it (uppercase host,
 * `:443`, dot segments). So a consumer that STORES or FORWARDS the raw argument, rather than
 * re-deriving `new URL(x).href`, would persist a value this predicate never approved. There are
 * two callers — `isAllowedImageScanUrl` below, which forwards the normalized form, and
 * `verifyAvatar`, the only one that STORES the raw value (into `User.image`). A third caller
 * that stores should be handed the normalized href instead. 🔴 Nothing mechanically enforces
 * that; it is prose on a path that persists.
 */
export function isAllowedAvatarUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // ⚠ Currently REDUNDANT, kept deliberately: every entry in AVATAR_URL_PREFIXES begins
  // `https://`, so the href-prefix test below already forces the scheme, and deleting this line
  // reddens nothing. It is one comparison, and it stops the scheme becoming implicit in the
  // prefix list's spelling if an entry is ever added without one.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (hasAmbiguousAuthority(parsed, url)) return false;
  // 🔴 An ENCODED separator does not collapse during href normalization, so
  // `…/avatars/..%2fattachments/x` keeps the allowed prefix while a fetcher or CDN that
  // decodes `%2F` before resolving the path escapes it. Whether any given client does that
  // cannot be settled from this repo, so refuse the shape rather than depend on the answer —
  // a real avatar path never carries an encoded slash or backslash.
  //
  // Both the `/i` and the `%5c` arm are load-bearing and separately pinned: WHATWG PRESERVES
  // the case of an existing percent-encoding in `pathname`, so `%2F` survives a lower-case-only
  // test, and `%5C` is the backslash spelling of the same escape.
  if (/%2f|%5c/i.test(parsed.pathname)) return false;
  return AVATAR_URL_PREFIXES.some((prefix) => parsed.href.startsWith(prefix));
}

/**
 * The exact string to hand onward. An absolute url is re-emitted as its parsed `href` so
 * our judgement and the fetcher's resolution cannot diverge; a relative key is returned
 * untouched for `getEdgeUrl` to prefix.
 */
export function normalizeImageScanUrl(url: string): string {
  if (!isEdgeUrlPassthrough(url)) return url;
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

export function isAllowedImageScanUrl(url: string): boolean {
  if (!url) return false;
  // NOTE: no explicit `blob:` check. Lowercase `blob:` IS passthrough and is refused by the
  // protocol test below; any other casing is not passthrough and is refused by
  // `SCHEME_PREFIX` on the relative branch. A dedicated check would reject nothing a later
  // one does not — the same reasoning that removed the old `startsWith('blob')` branch, and
  // it is applied here rather than left as dead cover claiming strength it no longer has.
  //
  // 🔴 Applied to BOTH branches, before the split. Hardening only the absolute branch left
  // the module inconsistent about the very character the differential is about: `\\evil.com/x`,
  // `\/evil.com/x` and `/\evil.com/x` carry no scheme and no leading `//`, so they were taken
  // as relative keys — and a WHATWG parser given a base resolves all three to host
  // `evil.com`. No legitimate CF key contains a backslash or a control byte.
  if (hasUrlAmbiguousBytes(url)) return false;

  // 🔴 The set to gate is exactly what `getEdgeUrl` forwards UNMODIFIED — hence the shared
  // predicate rather than a second spelling of it here.
  //
  // Do NOT re-narrow this to `/^https?:\/\//`: that requires the `//`, while `getEdgeUrl`
  // forwards on `startsWith('http')`. Strings in the gap — `http:/127.0.0.1:6379/`,
  // `http:evil.com/x` — were read as relative keys, forwarded verbatim, and normalized
  // back to absolute URLs by WHATWG URL parsing at the fetch: the SSRF this module closes.
  if (!isEdgeUrlPassthrough(url)) {
    // It must actually BE a relative key. "getEdgeUrl prefixes it onto our storage edge"
    // is env-conditional — `NEXT_PUBLIC_IMAGE_LOCATION` is `z.string().default('')`
    // (src/env/client-schema.ts) and `.filter(Boolean)` drops an empty prefix
    // (edge-url.ts) — so with it unset a scheme- or authority-bearing string would be
    // emitted essentially verbatim. Judge the shape, never the env.
    // 🔴 A LEADING space is the one byte `hasUrlAmbiguousBytes` cannot see (0x20 is above the
    // C0 range) and WHATWG strips it, so ` http://evil.com/x` and ` //evil.com/x` are not
    // `startsWith('http')`, do not match SCHEME_PREFIX, and do not start `//` — yet resolve to
    // a foreign host. Brute-forced over U+0000–U+02FF: U+0020 is the ONLY code point that
    // escapes all three tests.
    //
    // Only a LEADING run is refused, never an interior one: delivery filenames routinely
    // contain spaces (see edge-url.ts's srcset note), and a wrong rejection here is permanent
    // — status 400 stamps ingestion=Error at a retry ceiling of 1.
    if (/^\s/.test(url)) return false;
    if (SCHEME_PREFIX.test(url)) return false;
    if (url.startsWith('//')) return false;
    return true;
  }

  // NOTE: no second `startsWith('blob')` check here. A string that is passthrough but not
  // `blob:` (e.g. `blobx://image.civitai.com/a`) is already refused by the protocol test
  // below, and a bare `blob` fails to parse — so such a check would be unreachable.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // `startsWith('http')` also admits `httpx:` and friends; only real http(s) is fetchable.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (hasAmbiguousAuthority(parsed, url)) return false;

  // One predicate for the avatar rule, shared with `verifyAvatar` — see isAllowedAvatarUrl.
  if (isAllowedAvatarUrl(url)) return true;
  return isValidCivitaiImageUrl(parsed.href);
}
