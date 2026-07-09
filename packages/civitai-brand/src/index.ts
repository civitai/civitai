/**
 * @civitai/brand — framework-agnostic Civitai brand marks.
 *
 * Exposes the raw SVG geometry + gradient palettes (for apps that render
 * `<path>` natively and theme via CSS) and ready-made SVG-string builders (for
 * apps that inject markup via `{@html}` / `dangerouslySetInnerHTML`).
 *
 * No React, no DOM, no runtime dependencies.
 */

export {
  WORDMARK,
  WORDMARK_BASE_PATHS,
  WORDMARK_ACCENT_PATHS,
  BADGE,
} from './paths';

export {
  GRADIENTS,
  DEFAULT_GRADIENT,
  type GradientPalette,
  type GradientKey,
} from './gradients';

export { getHoliday, getThanksgivingDate, type Holiday } from './holiday';

export {
  buildWordmarkSvg,
  buildBadgeSvg,
  buildFaviconSvg,
  type WordmarkOptions,
  type BadgeOptions,
} from './svg';
