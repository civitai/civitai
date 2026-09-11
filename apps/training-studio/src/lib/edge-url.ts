import { hostConfig } from '$lib/host';

// SessionUser.image is a bare Cloudflare Images key, not a URL — handed straight to <img src> the browser
// resolves it against the current route and 404s. Build the CDN URL like the main app / moderator's
// getEdgeUrl (trimmed to the avatar case: a width transform). An already-absolute URL passes through.
const FALLBACK_BASE = 'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA';

export function getEdgeUrl(src: string | undefined, width = 96): string | undefined {
  if (!src) return undefined;
  if (src.startsWith('http') || src.startsWith('blob')) return src;
  const base = hostConfig().imageLocation || FALLBACK_BASE;
  return [base, src, `width=${width}`].join('/');
}
