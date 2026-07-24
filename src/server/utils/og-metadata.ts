/**
 * PURE (no network) OpenGraph / HTML metadata extraction for the App Blocks
 * external-listing auto-pull. Given a page's HTML + its final (post-redirect) URL,
 * pull the best-effort SUGGESTIONS an author can accept or override:
 *
 *   og:title  / <title>               → suggested NAME
 *   og:description / meta description  → suggested TAGLINE (short) + DESCRIPTION (long)
 *   og:image  / twitter:image          → suggested COVER image URL
 *   apple-touch-icon / rel=icon        → suggested ICON image URL
 *   header/nav <img> (last resort)     → suggested ICON when no favicon resolves
 *
 * There is no HTML-parser dependency in this repo (no cheerio / node-html-parser),
 * and `unfurl.js` does its OWN unguarded outbound fetch — so this is a small,
 * dependency-free regex extractor. It is best-effort ONLY: the output is a set of
 * SUGGESTIONS, never persisted directly, and any image URL is re-fetched through
 * the SSRF-hardened `safeFetch` on accept — so a fragile parse can under-suggest
 * (→ the UI falls back to manual upload) but can never bypass a security control.
 *
 * Relative asset URLs (`/favicon.ico`, `og.png`) are resolved against the final
 * page URL. Missing tags yield `undefined` fields (never throws).
 */

const MAX_NAME_LEN = 120; // mirrors OFFSITE_NAME_MAX
const MAX_TAGLINE_LEN = 140; // mirrors OFFSITE_TAGLINE_MAX
const MAX_DESCRIPTION_LEN = 2000; // mirrors OFFSITE_DESCRIPTION_MAX

/**
 * Explicit `width`/`height` at or below this many pixels marks an `<img>` as a
 * tracking pixel / sprite rather than a real logo, so the header/nav icon
 * fallback skips it. A logo is never 32px or smaller on either declared side.
 */
const MIN_HEADER_IMG_PX = 32;
// Only the first slice of a document is parsed for metadata — all signals (og:*,
// <title>, <link rel=icon>, brand/header <img>) live at the page top. Bounds the
// cost of scanning adversarial HTML (see extractListingMeta).
const META_HTML_PARSE_CAP = 256_000;
// A single <header>/<nav> block is never anywhere near this large; bounding the
// lazy inner capture stops the container regex from rescanning to EOF at every
// unmatched open tag (the O(n^2) event-loop-freeze vector on hostile input).
const HEADER_NAV_BLOCK_MAX = 8_000;

export type ListingMetaSuggestion = {
  name?: string;
  tagline?: string;
  /** Longer body copy for the Description field (og:description, clamped longer). */
  description?: string;
  coverImageUrl?: string;
  iconImageUrl?: string;
};

/** Read one attribute value from a single tag string (double, single, or unquoted). */
function getAttr(tag: string, attr: string): string | undefined {
  // Negative lookbehind for a word-char or hyphen so `name` doesn't match inside
  // `data-name` / `itemname`, and `content` doesn't match `data-content`.
  const re = new RegExp(`(?<![\\w-])${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return undefined;
  const raw = m[2] ?? m[3] ?? m[4];
  return raw !== undefined ? decodeEntities(raw).trim() : undefined;
}

/** Minimal HTML-entity decoder for the handful that appear in titles/descriptions. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    // &amp; LAST so an entity like `&amp;lt;` isn't double-decoded.
    .replace(/&amp;/gi, '&');
}

function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/** All `<meta ...>` tags → a map keyed by lowercased `property`/`name` → `content`. */
function extractMetaMap(html: string): Map<string, string> {
  const map = new Map<string, string>();
  const metaRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    const key = getAttr(tag, 'property') ?? getAttr(tag, 'name');
    if (!key) continue;
    const content = getAttr(tag, 'content');
    if (content === undefined) continue;
    const lower = key.toLowerCase();
    // First occurrence wins (OG tags are usually in <head> order; don't let a
    // later duplicate override the canonical one).
    if (!map.has(lower)) map.set(lower, content);
  }
  return map;
}

type IconCandidate = { rel: string; href: string; sizePx: number };

/** All `<link rel=... href=...>` icon candidates (rel contains "icon"). */
function extractIconCandidates(html: string): IconCandidate[] {
  const out: IconCandidate[] = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    const rel = getAttr(tag, 'rel')?.toLowerCase();
    if (!rel || !rel.includes('icon')) continue;
    const href = getAttr(tag, 'href');
    if (!href) continue;
    const sizes = getAttr(tag, 'sizes') ?? '';
    const sizeMatch = /(\d+)x(\d+)/i.exec(sizes);
    const sizePx = sizeMatch ? Number(sizeMatch[1]) : 0;
    out.push({ rel, href, sizePx });
  }
  return out;
}

/** The `<title>` text (first occurrence), decoded + trimmed. */
function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const text = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Pick the best icon href from the candidates: prefer `apple-touch-icon` (large,
 * high-quality), then the largest declared `rel=icon`, then any icon. Returns the
 * raw (possibly relative) href.
 */
function pickIconHref(candidates: IconCandidate[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const apple = candidates
    .filter((c) => c.rel.includes('apple-touch-icon'))
    .sort((a, b) => b.sizePx - a.sizePx);
  if (apple.length > 0) return apple[0].href;
  const icons = candidates
    .filter((c) => c.rel.includes('icon'))
    .sort((a, b) => b.sizePx - a.sizePx);
  return icons[0]?.href;
}

/**
 * LAST-RESORT icon fallback: when no `<link rel=icon>` / apple-touch-icon
 * resolves, scan the page for a plausible header/brand `<img>` — the first
 * `<img>` inside a `<header>` or `<nav>`, or (anywhere) an `<img>` whose
 * `class`/`alt`/`id` mentions "logo" or "header". PURE + best-effort; returns the
 * raw (possibly relative) `src` of the first SANE candidate, or `undefined`.
 *
 * Candidates are collected in priority order (header/nav imgs, then logo-classed
 * imgs) and the FIRST that survives the sanity bounds wins — so a leading spacer /
 * tracking pixel in the header is skipped in favour of the real logo behind it.
 *
 * Bounded so it never suggests junk: a `data:` src is skipped (resolveUrl would
 * drop it anyway), and an explicitly tiny `<img>` (declared width OR height
 * ≤ {@link MIN_HEADER_IMG_PX}px — a tracking pixel / UI sprite) is skipped. It is
 * ALWAYS a suggestion the author accepts or overrides — never auto-committed — and
 * the accepted URL is re-fetched through the SSRF-safe `safeFetch` like any other.
 */
function extractHeaderNavImgHref(html: string): string | undefined {
  const candidateTags: string[] = [];

  // (1) Every <img> inside each <header>/<nav> block, in document order (highest
  // priority). All of them — so a leading spacer/pixel doesn't shadow the real logo.
  const containerRe = new RegExp(
    `<(header|nav)\\b[^>]*>([\\s\\S]{0,${HEADER_NAV_BLOCK_MAX}}?)<\\/\\1>`,
    'gi'
  );
  let container: RegExpExecArray | null;
  while ((container = containerRe.exec(html)) !== null) {
    const inner = container[2];
    const innerImgRe = /<img\b[^>]*>/gi;
    let innerImg: RegExpExecArray | null;
    while ((innerImg = innerImgRe.exec(inner)) !== null) candidateTags.push(innerImg[0]);
  }

  // (2) Any <img> that self-identifies as a logo/header via class/alt/id.
  const imgRe = /<img\b[^>]*>/gi;
  let img: RegExpExecArray | null;
  while ((img = imgRe.exec(html)) !== null) {
    const tag = img[0];
    const cls = getAttr(tag, 'class') ?? '';
    const alt = getAttr(tag, 'alt') ?? '';
    const id = getAttr(tag, 'id') ?? '';
    if (/logo|header|brand/i.test(cls) || /logo/i.test(alt) || /logo|header/i.test(id)) {
      candidateTags.push(tag);
    }
  }

  for (const tag of candidateTags) {
    const src = getAttr(tag, 'src');
    if (!src) continue;
    const trimmed = src.trim();
    if (trimmed.length === 0 || /^data:/i.test(trimmed)) continue;
    // Skip an explicitly tiny image (a tracking pixel / sprite is never a logo).
    const w = Number(getAttr(tag, 'width'));
    const h = Number(getAttr(tag, 'height'));
    if (
      (Number.isFinite(w) && w > 0 && w <= MIN_HEADER_IMG_PX) ||
      (Number.isFinite(h) && h > 0 && h <= MIN_HEADER_IMG_PX)
    ) {
      continue;
    }
    return trimmed;
  }
  return undefined;
}

/**
 * Resolve a possibly-relative asset URL against the final page URL; drop
 * unparseable OR non-https results. https-only mirrors the accept-side `safeFetch`
 * (which is https-only): a suggested `http://` image would render as a
 * mixed-content preview client-side but then FAIL ingestion on accept — so we
 * never suggest one (the UI falls back to manual upload instead).
 */
function resolveUrl(href: string | undefined, baseUrl: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (trimmed.length === 0) return undefined;
  // Skip data: URIs and other non-fetchable schemes early — the accept-side
  // safeFetch would reject them anyway, but there's no point suggesting them.
  if (/^data:/i.test(trimmed)) return undefined;
  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return undefined;
  }
  // Only https suggestions — matches what safeFetch can actually ingest, so the
  // preview never shows an asset the accept step will reject.
  if (resolved.protocol !== 'https:') return undefined;
  return resolved.toString();
}

function clamp(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  if (t.length === 0) return undefined;
  return t.length > max ? t.slice(0, max).trim() : t;
}

/**
 * Extract the listing-metadata suggestions from a page's HTML. Resolves relative
 * asset URLs against `finalUrl` (the post-redirect page URL). Every field is
 * optional — a page with no usable tags returns `{}` (the UI then falls back to
 * manual entry / upload). Never throws.
 */
export function extractListingMeta(html: string, finalUrl: string): ListingMetaSuggestion {
  // Parse only a prefix of the document. Every signal we pull (og:*, <title>,
  // <link rel=icon>, and a brand/header <img>) lives at the top of the page, so a
  // cap costs no extraction quality — but it bounds the cost of scanning
  // adversarial HTML (the fetch's byte cap is ~1.5MB; without this cap the
  // header/nav container scan is super-linear and a hostile body can freeze the
  // event loop for tens of seconds). Defence-in-depth with the bounded quantifier
  // in extractHeaderNavImgHref.
  if (html.length > META_HTML_PARSE_CAP) html = html.slice(0, META_HTML_PARSE_CAP);
  const meta = extractMetaMap(html);

  const name = clamp(meta.get('og:title') ?? extractTitle(html), MAX_NAME_LEN);
  // og:description feeds BOTH the short tagline (clamped tight) and the longer
  // Description body (clamped to the description bound) — the same source, two
  // fields the author can accept/edit/clear independently.
  const rawDescription =
    meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description');
  const tagline = clamp(rawDescription, MAX_TAGLINE_LEN);
  const description = clamp(rawDescription, MAX_DESCRIPTION_LEN);

  const coverHref =
    meta.get('og:image') ??
    meta.get('og:image:url') ??
    meta.get('og:image:secure_url') ??
    meta.get('twitter:image') ??
    meta.get('twitter:image:src');
  const coverImageUrl = resolveUrl(coverHref, finalUrl);

  // Favicon / apple-touch-icon first; a header/nav brand <img> is the LAST-RESORT
  // icon so a site with no declared icon still gets a suggestion (never
  // auto-committed — the author accepts it, then it re-fetches through safeFetch).
  const iconImageUrl =
    resolveUrl(pickIconHref(extractIconCandidates(html)), finalUrl) ??
    resolveUrl(extractHeaderNavImgHref(html), finalUrl);

  const result: ListingMetaSuggestion = {};
  if (name) result.name = name;
  if (tagline) result.tagline = tagline;
  if (description) result.description = description;
  if (coverImageUrl) result.coverImageUrl = coverImageUrl;
  if (iconImageUrl) result.iconImageUrl = iconImageUrl;
  return result;
}
