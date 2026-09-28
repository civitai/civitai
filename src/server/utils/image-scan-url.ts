import { isValidCivitaiImageUrl } from '~/utils/article-helpers';

/**
 * Allowlist for the URLs the image-scan ingestion may be pointed at.
 *
 * The orchestrator fetches `mediaUrl` server-side from inside the cluster, so any
 * caller-controlled absolute URL that reaches `Image.url` is an SSRF primitive: the
 * comics procs, article content media nodes and several other paths pass raw client
 * URLs into `createImage`, and `getEdgeUrl` forwards absolute `http(s)`/`blob:` URLs
 * through UNMODIFIED (edge-url.ts). Everything else — relative CF UUID keys — is
 * prefixed with `NEXT_PUBLIC_IMAGE_LOCATION` before submission and can only land on
 * our storage edge, so relative URLs are allowed outright.
 *
 * Absolute URLs must be one of:
 *  - our storage hosts (`isValidCivitaiImageUrl`: image.civitai.com + subdomains,
 *    civitai.com, wasabisys.com, civitai-prod.s3.amazonaws.com);
 *  - the OAuth avatar hosts actually present in `Image` data. These are checked as
 *    HOST+PATH PREFIXES, not bare hosts: `cdn.discordapp.com` also serves arbitrary
 *    user-uploaded `/attachments/…` files, so a bare-host check would let a submit
 *    point the scanner at attacker-chosen content on a real CDN. The same prefix list
 *    guards avatar updates in user.controller — keep the two identical.
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

export function isAllowedImageScanUrl(url: string): boolean {
  if (!url) return false;
  if (/^blob:/i.test(url)) return false;
  // Relative — CF UUID keys like `<uuid>/<name>.png` — resolves onto our storage edge.
  if (!/^https?:\/\//i.test(url)) return true;
  if (AVATAR_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) return true;
  return isValidCivitaiImageUrl(url);
}
