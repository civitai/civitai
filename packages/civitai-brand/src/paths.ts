/**
 * Raw SVG geometry for the Civitai brand marks.
 *
 * This module is framework-agnostic: it exposes only path `d` strings and
 * viewBoxes. Consumers either render `<path>` elements themselves (React,
 * Svelte, etc.) or use the string builders in `./svg`.
 */

/**
 * The horizontal "civitai" wordmark (logotype).
 *
 * The paths are split into two color groups so the wordmark can be themed:
 * - `base`   — the letters (typically near-black / theme foreground)
 * - `accent` — the trailing "ai" + corner triangle (typically brand blue)
 */
export const WORDMARK = {
  viewBox: '0 0 107 22.7',
  paths: {
    /** "civit" letters — base color */
    c: 'M20.8,1.7H3.7L1.5,4.1v15l2.3,2.3h17.1v-5.2H6.7V7h14.1V1.7z',
    ivit:
      'M76.1,1.7H56.6V7h7.2v14.3H69V7h7C76,7,76.1,1.7,76.1,1.7z M23.2,1.8v19.5h5.2V1.8C28.4,1.8,23.2,1.8,23.2,1.8z M30.8,1.8v19.5h7.6l8.3-8.3V1.8h-5.2v8.3l-5.4,6V1.8C36.1,1.8,30.8,1.8,30.8,1.8z M49.1,1.8v19.5h5.2V1.8C54.3,1.8,49.1,1.8,49.1,1.8z',
    /** "ai" letters — accent color */
    ai: 'M100.3,1.8v19.5h5.2V1.8H100.3z M95.6,1.8H80.8l-2.3,2.3v17.2h5.2v-7.1h8.9v7.1h5.2V4.1C97.8,4.1,95.6,1.8,95.6,1.8z M92.7,8.9h-8.9V7h8.9V8.9z',
    /** corner triangle accent */
    accent: 'M46.7,16.2v5.1h-5.1',
  },
} as const;

/** Path keys that take the wordmark's base color. */
export const WORDMARK_BASE_PATHS = ['c', 'ivit'] as const;
/** Path keys that take the wordmark's accent color. */
export const WORDMARK_ACCENT_PATHS = ['ai', 'accent'] as const;

/**
 * The diamond "C" badge mark.
 *
 * Three stacked layers:
 * - `inner`  — inner diamond (filled with the inner gradient)
 * - `outer`  — outer diamond ring (filled with the outer gradient)
 * - `letter` — the white "C" cut-out
 *
 * The gradient geometry (below) matches the original mark so holiday palettes
 * render identically.
 */
export const BADGE = {
  viewBox: '-1 0 22.7 22.7',
  paths: {
    inner: 'M1.5,6.6v10l8.7,5l8.7-5v-10l-8.7-5L1.5,6.6z',
    outer:
      'M10.2,4.7l5.9,3.4V15l-5.9,3.4L4.2,15V8.1L10.2,4.7 M10.2,1.6l-8.7,5v10l8.7,5l8.7-5v-10C18.8,6.6,10.2,1.6,10.2,1.6z',
    letter:
      'M11.8,12.4l-1.7,1l-1.7-1v-1.9l1.7-1l1.7,1h2.1V9.3l-3.8-2.2L6.4,9.3v4.3l3.8,2.2l3.8-2.2v-1.2H11.8z',
  },
  /** Linear-gradient definitions used by the two-stop (non-pride) palettes. */
  gradient: {
    inner: {
      gradientUnits: 'userSpaceOnUse',
      x1: '10.156',
      y1: '22.45',
      x2: '10.156',
      y2: '2.4614',
      gradientTransform: 'matrix(1 0 0 -1 0 24)',
    },
    outer: {
      gradientUnits: 'userSpaceOnUse',
      x1: '10.156',
      y1: '22.45',
      x2: '10.156',
      y2: '2.45',
      gradientTransform: 'matrix(1 0 0 -1 0 24)',
    },
  },
} as const;
