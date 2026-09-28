import { isValidCivitaiImageUrl } from '~/utils/article-helpers';
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
 * ⚠ KNOWN RESIDUAL, deliberately not closed here: `isValidCivitaiImageUrl` matches
 * `wasabisys.com` as a bare SUFFIX, and `<bucket>.s3.wasabisys.com` is a self-service
 * global namespace — so an allowlisted hostname is third-party registerable, which also
 * means an attacker-controlled redirect sits on an allowlisted host. That only becomes a
 * full bypass if the orchestrator's fetch FOLLOWS redirects, which cannot be settled from
 * this repo. Narrowing to the exact legacy bucket hosts is the fix if it does.
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
  return raw.includes('\\') || !!parsed.username || !!parsed.password;
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
  // Never fetchable server-side, so only ever a guaranteed-failed workflow. Checked
  // case-insensitively — strictly stronger than the passthrough test below.
  if (/^blob:/i.test(url)) return false;

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

  // 🔴 Prefixes are tested against the NORMALIZED href, never the raw string:
  // `…/avatars/../attachments/x` passes a raw `startsWith` and resolves to
  // `/attachments/x` — the arbitrary-upload surface these prefixes exist to exclude.
  if (AVATAR_URL_PREFIXES.some((prefix) => parsed.href.startsWith(prefix))) return true;
  return isValidCivitaiImageUrl(parsed.href);
}
