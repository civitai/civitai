/**
 * Brand gradient palettes, keyed by holiday theme.
 *
 * Each palette has an `inner` and `outer` color list. Two-color lists render as
 * a simple two-stop linear gradient; longer lists (e.g. `pride`) render as an
 * evenly-spaced multi-stop gradient.
 */

export type GradientPalette = {
  inner: string[];
  outer: string[];
};

export const GRADIENTS = {
  blue: {
    inner: ['#081692', '#1E043C'],
    outer: ['#1284F7', '#0A20C9'],
  },
  green: {
    inner: ['#081692', '#1E043C'],
    outer: ['#1284F7', '#0A20C9'],
  },
  halloween: {
    inner: ['#926711', '#3C1F0E'],
    outer: ['#F78C22', '#C98C17'],
  },
  christmas: {
    inner: ['#7B0A0A', '#2C0202'],
    outer: ['#FF3B30', '#C21A1A'],
  },
  newyear: {
    inner: ['#081692', '#1E043C'],
    outer: ['#1284F7', '#0A20C9'],
  },
  stpatty: {
    inner: ['#135F20', '#020709'],
    outer: ['#53C42B', '#1D962F'],
  },
  pride: {
    inner: ['#746A11', '#2A7911', '#117642', '#106A71', '#0E145E', '#200D57'],
    outer: ['#E04A4A', '#E04A4A', '#E0B54A', '#4AE0D4', '#4A6AE0', '#D44AE0'],
  },
} as const satisfies Record<string, GradientPalette>;

/** A key into {@link GRADIENTS}. */
export type GradientKey = keyof typeof GRADIENTS;

/** The default (non-holiday) palette. */
export const DEFAULT_GRADIENT: GradientKey = 'blue';
