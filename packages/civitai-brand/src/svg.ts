/**
 * Framework-agnostic SVG-string builders for the Civitai brand marks.
 *
 * These return complete, self-contained `<svg>` markup so any framework can
 * inject them directly:
 * - Svelte:  `{@html buildBadgeSvg({ holiday })}`
 * - Vue:     `v-html="buildBadgeSvg({ holiday })"`
 * - React:   `<span dangerouslySetInnerHTML={{ __html: buildBadgeSvg(...) }} />`
 * - Vanilla: `el.innerHTML = buildWordmarkSvg(...)`
 *
 * Apps that want native elements (and CSS-class theming) should import the raw
 * data from `./paths` + `./gradients` and render `<path>` themselves instead.
 */

import { BADGE, WORDMARK } from './paths';
import { DEFAULT_GRADIENT, GRADIENTS, type GradientKey } from './gradients';
import type { Holiday } from './holiday';

export type WordmarkOptions = {
  /** Color for the "civit" letters. Default `#222`. */
  base?: string;
  /** Color for the "ai" letters + corner triangle. Default `#1971c2`. */
  accent?: string;
};

export type BadgeOptions = {
  /** Active holiday theme; selects the gradient palette. Ignored if `gradient` is set. */
  holiday?: Holiday | null;
  /** Explicit gradient palette override (takes precedence over `holiday`). */
  gradient?: GradientKey;
  /**
   * Prefix for the generated `<linearGradient>` ids. Set this to a unique value
   * when rendering more than one badge on a page so gradient ids don't collide.
   * Default `civitai`.
   */
  idPrefix?: string;
};

/** The horizontal "civitai" wordmark as an SVG string. */
export function buildWordmarkSvg(opts: WordmarkOptions = {}): string {
  const base = opts.base ?? '#222';
  const accent = opts.accent ?? '#1971c2';
  const p = WORDMARK.paths;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${WORDMARK.viewBox}"><g>` +
    `<path fill="${base}" d="${p.c}"/>` +
    `<path fill="${base}" d="${p.ivit}"/>` +
    `<path fill="${accent}" d="${p.ai}"/>` +
    `<path fill="${accent}" d="${p.accent}"/>` +
    `</g></svg>`
  );
}

/**
 * The Civitai favicon — the diamond "C" badge as a standalone SVG document, ready for
 * `<link rel="icon" type="image/svg+xml">`. Same mark as {@link buildBadgeSvg}; the only
 * difference is a `favicon`-scoped gradient id (so it never collides with an inline badge on
 * the same origin) and an explicit square `width`/`height` for hosts that ignore the viewBox.
 * Transparent background — the blue gradient + white "C" read on both light and dark tab bars.
 */
export function buildFaviconSvg(opts: Omit<BadgeOptions, 'idPrefix'> = {}): string {
  return buildBadgeSvg({ ...opts, idPrefix: 'favicon' }).replace(
    '<svg ',
    '<svg width="32" height="32" '
  );
}

/** The diamond "C" badge as an SVG string, themed by holiday/gradient. */
export function buildBadgeSvg(opts: BadgeOptions = {}): string {
  const key: GradientKey = opts.gradient ?? opts.holiday ?? DEFAULT_GRADIENT;
  const palette = GRADIENTS[key];
  const prefix = opts.idPrefix ?? 'civitai';
  const innerId = `${prefix}-badge-inner`;
  const outerId = `${prefix}-badge-outer`;
  const p = BADGE.paths;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BADGE.viewBox}"><defs>` +
    linearGradientDef(innerId, palette.inner, BADGE.gradient.inner) +
    linearGradientDef(outerId, palette.outer, BADGE.gradient.outer) +
    `</defs><g>` +
    `<path fill="url(#${innerId})" d="${p.inner}"/>` +
    `<path fill="url(#${outerId})" d="${p.outer}"/>` +
    `<path fill="#fff" d="${p.letter}"/>` +
    `</g></svg>`
  );
}

/**
 * Build a `<linearGradient>` definition. Two-color palettes use the supplied
 * userSpace geometry; longer palettes (e.g. pride) render as an evenly-spaced
 * 45°-rotated multi-stop gradient — matching the original mark.
 */
function linearGradientDef(
  id: string,
  colors: readonly string[],
  geom: Readonly<Record<string, string>>
): string {
  if (colors.length > 2) {
    const stops = colors
      .map((c, i) => `<stop offset="${(i / (colors.length - 1)) * 100}%" stop-color="${c}"/>`)
      .join('');
    return `<linearGradient id="${id}" gradientTransform="rotate(45)">${stops}</linearGradient>`;
  }
  const attrs = Object.entries(geom)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const stops =
    `<stop offset="0" stop-color="${colors[0]}"/>` +
    `<stop offset="1" stop-color="${colors[colors.length - 1]}"/>`;
  return `<linearGradient id="${id}" ${attrs}>${stops}</linearGradient>`;
}
