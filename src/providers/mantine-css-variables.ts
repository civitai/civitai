import type {
  ConvertCSSVariablesInput,
  CSSVariablesResolver,
  MantineTheme,
  MantineThemeOverride,
} from '@mantine/core';
import {
  convertCssVariables,
  DEFAULT_THEME,
  deepMerge,
  defaultCssVariablesResolver,
  keys,
  mergeMantineTheme,
} from '@mantine/core';

/**
 * Precompute Mantine's CSS-variables `<style>` payload ONCE at module scope instead of
 * regenerating it on every SSR render.
 *
 * Mantine's internal `<MantineCssVariables>` (rendered by `MantineProvider` when
 * `withCssVariables` is `true`) runs `getMergedVariables` → `removeDefaultVariables` →
 * `convertCssVariables` on EVERY render of EVERY page. A fresh SSR CPU profile attributed
 * ~3.2% of SSR busy time (plus co-dependent GC) to that per-render work.
 *
 * The output depends ONLY on request-invariant inputs — the theme (a module constant in
 * `ThemeProvider`), the (absent) `cssVariablesResolver`, `cssVariablesSelector` and
 * `deduplicateCssVariables` — and NOT on `colorScheme` (the block always emits both the
 * light and dark variable sets). So it is safe to compute once and reuse.
 *
 * This module re-implements Mantine v7's `MantineCssVariables` render body byte-for-byte
 * using only Mantine's PUBLIC exports (no node_modules fork/patch). `getMergedVariables`
 * and `removeDefaultVariables` are not exported, so they are mirrored here verbatim from
 * `@mantine/core@7.17.8`. A test asserts the produced string is identical to what the real
 * `<MantineProvider>` renders for every color scheme (see
 * `mantine-css-variables.test.ts`).
 */

// Verbatim mirror of `@mantine/core`'s internal `getMergedVariables`
// (core/MantineProvider/MantineCssVariables/get-merged-variables.mjs).
function getMergedVariables(theme: MantineTheme, generator?: CSSVariablesResolver) {
  const defaultResolver = defaultCssVariablesResolver(theme);
  const providerGenerator = generator?.(theme);
  return providerGenerator ? deepMerge(defaultResolver, providerGenerator) : defaultResolver;
}

// Verbatim mirror of `@mantine/core`'s internal `removeDefaultVariables`
// (core/MantineProvider/MantineCssVariables/remove-default-variables.mjs).
const defaultCssVariables = defaultCssVariablesResolver(DEFAULT_THEME);
function removeDefaultVariables(input: ConvertCSSVariablesInput): ConvertCSSVariablesInput {
  const cleaned: ConvertCSSVariablesInput = {
    variables: {},
    light: {},
    dark: {},
  };

  keys(input.variables).forEach((key) => {
    if (defaultCssVariables.variables[key] !== input.variables[key]) {
      cleaned.variables[key] = input.variables[key];
    }
  });

  keys(input.light).forEach((key) => {
    if (defaultCssVariables.light[key] !== input.light[key]) {
      cleaned.light[key] = input.light[key];
    }
  });

  keys(input.dark).forEach((key) => {
    if (defaultCssVariables.dark[key] !== input.dark[key]) {
      cleaned.dark[key] = input.dark[key];
    }
  });

  return cleaned;
}

// Verbatim mirror of `@mantine/core`'s internal `getColorSchemeCssVariables`
// (core/MantineProvider/MantineCssVariables/MantineCssVariables.mjs).
function getColorSchemeCssVariables(selector: string) {
  return `
  ${selector}[data-mantine-color-scheme="dark"] { --mantine-color-scheme: dark; }
  ${selector}[data-mantine-color-scheme="light"] { --mantine-color-scheme: light; }
`;
}

export interface BuildMantineCssVariablesOptions {
  /** Mirrors `MantineProvider` prop of the same name. `:root` by default. */
  cssVariablesSelector?: string;
  /** Mirrors `MantineProvider` prop of the same name. `true` by default. */
  deduplicateCssVariables?: boolean;
  /** Mirrors `MantineProvider` prop of the same name. Absent by default. */
  cssVariablesResolver?: CSSVariablesResolver;
}

/**
 * Build the exact `__html` string Mantine's `<MantineCssVariables>` injects into its
 * `<style data-mantine-styles>` tag for the given theme override.
 *
 * The theme override is merged with `DEFAULT_THEME` here exactly as `MantineThemeProvider`
 * does at the top level (`mergeMantineTheme(DEFAULT_THEME, theme)`), so the result matches
 * what the live provider renders. Returns `''` when Mantine would render nothing.
 */
export function buildMantineCssVariablesHtml(
  themeOverride: MantineThemeOverride,
  {
    cssVariablesSelector = ':root',
    deduplicateCssVariables = true,
    cssVariablesResolver,
  }: BuildMantineCssVariablesOptions = {}
): string {
  const theme = mergeMantineTheme(DEFAULT_THEME, themeOverride);
  const mergedVariables = getMergedVariables(theme, cssVariablesResolver);
  const shouldCleanVariables = cssVariablesSelector === ':root' && deduplicateCssVariables;
  const cleanedVariables = shouldCleanVariables
    ? removeDefaultVariables(mergedVariables)
    : mergedVariables;
  const css = convertCssVariables(cleanedVariables, cssVariablesSelector);

  if (!css) return '';

  return `${css}${shouldCleanVariables ? '' : getColorSchemeCssVariables(cssVariablesSelector)}`;
}
