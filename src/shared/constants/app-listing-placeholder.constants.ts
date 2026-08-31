/**
 * App Store Listings (W13) — deterministic listing PLACEHOLDER primitives.
 *
 * Shared by BOTH:
 *   - the server-side generated placeholder assets
 *     (`app-listing-assets.service` → `buildPlaceholderIconSvg` /
 *     `buildPlaceholderCoverSvg`, rasterised to real `Image` rows), and
 *   - the CLIENT render-time fallback for a listing that has NO icon / cover
 *     (`AppListingCard`, `AppListingDetailBody`).
 *
 * WHY THIS MODULE EXISTS (the extraction): these are pure functions, but they
 * used to live only inside `app-listing-assets.service.ts`, which imports
 * `dbRead`/`dbWrite`/`sharp`. A client component therefore could NOT reuse them,
 * so the card/detail hand-rolled a DIFFERENT, weaker placeholder (one flat dark
 * gradient for every app + a generic icon). The two designs drifted: a listing
 * whose generated icon was a seeded-hue monogram sat on a card whose cover
 * placeholder was uniform grey. Pulling the primitives into `src/shared` lets the
 * live fallback and the generated asset derive from the SAME seed, so a
 * below-floor listing looks intentional and per-app rather than broken.
 *
 * Pure + framework-free ON PURPOSE — no React, no Prisma, no `sharp`. Keep it
 * that way so both sides can import it (a server-only import here would put the
 * client back where it started).
 *
 * The mandatory-asset FLOOR (icon + cover, `checkListingMeetsFloor`) is
 * unaffected: these placeholders are a RENDER-time fallback, never a stored
 * asset, so they can't satisfy — or be mistaken for — a real uploaded asset.
 */

/**
 * Category → a compact ASCII-safe glyph. Used verbatim in the generated SVG
 * placeholders. The CLIENT prefers a real tabler icon for the same category and
 * falls back to this glyph only for a category with no icon mapping, so the two
 * surfaces stay visually aligned without the client shipping the SVG text.
 */
export const CATEGORY_GLYPH: Record<string, string> = {
  generation: '✦',
  games: '◆',
  utility: '⚙',
  discovery: '◈',
  moderation: '⛨',
  analytics: '▤',
  other: '●',
};

/** The glyph for a (possibly null / unknown) category, never undefined. */
export function categoryGlyph(category: string | null | undefined): string {
  return CATEGORY_GLYPH[category ?? 'other'] ?? CATEGORY_GLYPH.other;
}

/**
 * FNV-1a → a stable 0..359 hue from a seed string (deterministic per slug).
 *
 * Deterministic is the whole point: the same listing must get the same colour on
 * every render, on every device, and in the generated asset — otherwise the
 * placeholder flickers between SSR and hydration.
 */
export function seededHue(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % 360;
}

/**
 * The app's display initial — the first LETTER-or-DIGIT of the name, else of the
 * slug, uppercased; `'?'` only when neither yields one.
 *
 * 🔴 The class is Unicode `\p{L}\p{N}`, NOT `[A-Za-z0-9]`. An ASCII-only class
 * silently renders a literal `?` for every non-Latin app name (日本語アプリ,
 * Привет, العربية) and strips the accent off `Émile` → `M` — i.e. exactly the
 * "this listing looks broken" outcome these placeholders exist to prevent. App
 * names are unrestricted free text (`offsite-listing.schema` bounds only length),
 * so non-Latin names are reachable, not hypothetical.
 *
 * The `u` flag is load-bearing: it makes the match code-point-based, so an
 * astral-plane first character returns a WHOLE code point rather than a lone
 * broken surrogate half.
 *
 * A name that is blank OR yields no letter/digit (e.g. "—", "🎨") falls through
 * to the slug before giving up — the slug is DNS-label-shaped, so it almost
 * always yields one.
 */
const INITIAL_CHAR = /[\p{L}\p{N}]/u;

export function appInitial(name: string, slug: string): string {
  const m = name?.trim().match(INITIAL_CHAR) ?? null;
  if (m) return m[0].toUpperCase();
  const s = slug?.trim().match(INITIAL_CHAR) ?? null;
  return (s ? s[0] : '?').toUpperCase();
}

/**
 * The seed a listing's placeholder colour derives from. SINGLE SOURCE so the
 * server-generated asset and the client fallback can never disagree — changing
 * the seed shape here changes both at once (that is deliberate).
 */
export function listingPlaceholderSeed(slug: string, category: string | null | undefined): string {
  return `${category ?? 'other'}:${slug}`;
}

/** The two hues of a listing's diagonal placeholder gradient. */
export function placeholderHues(seed: string): { hue: number; hue2: number } {
  const hue = seededHue(seed);
  return { hue, hue2: (hue + 40) % 360 };
}

/**
 * Saturation/lightness pairs per surface. Kept as data (not inlined) so the SVG
 * builders and the CSS builder below provably use the SAME values — this is what
 * makes a generated icon and a live cover placeholder read as one system.
 */
const SURFACE_STOPS = {
  /** Square app icon — brighter, it sits small against the card surface. */
  icon: { from: { s: 55, l: 42 }, to: { s: 60, l: 22 } },
  /** Landscape cover — dimmer, it sits behind foreground text/glyph. */
  cover: { from: { s: 45, l: 32 }, to: { s: 50, l: 16 } },
} as const;

export type PlaceholderSurface = keyof typeof SURFACE_STOPS;

/** One `hsl()` stop for a surface, as a CSS/SVG-safe colour string. */
export function placeholderStop(
  surface: PlaceholderSurface,
  which: 'from' | 'to',
  hue: number
): string {
  const { s, l } = SURFACE_STOPS[surface][which];
  return `hsl(${hue} ${s}% ${l}%)`;
}

/**
 * The CSS `linear-gradient(...)` for a listing's placeholder on a given surface.
 * 135deg matches the SVG builders' x1,y1 → x2,y2 diagonal.
 *
 * Client-side render fallback ONLY — this never becomes a stored asset.
 */
export function listingPlaceholderGradient(args: {
  slug: string;
  category: string | null | undefined;
  surface: PlaceholderSurface;
}): string {
  const { hue, hue2 } = placeholderHues(listingPlaceholderSeed(args.slug, args.category));
  return `linear-gradient(135deg, ${placeholderStop(
    args.surface,
    'from',
    hue
  )} 0%, ${placeholderStop(args.surface, 'to', hue2)} 100%)`;
}
