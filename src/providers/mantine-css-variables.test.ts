import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MantineColorScheme, MantineThemeOverride, CSSVariablesResolver } from '@mantine/core';
import { createTheme, MantineProvider } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { buildMantineCssVariablesHtml } from '~/providers/mantine-css-variables';
import { theme as appTheme } from '~/providers/ThemeProvider';

/**
 * BYTE-IDENTICAL GATE (load-bearing safety test).
 *
 * This is a GLOBAL change: the memoized CSS-variables `<style>` themes every page. If the
 * precomputed output differs from what Mantine's live `<MantineProvider>` renders per-request,
 * theming breaks fleet-wide.
 *
 * `renderRealMantineCssVars` renders the REAL `<MantineProvider withCssVariables>` (which
 * mounts Mantine's internal `<MantineCssVariables>` — the exact code path this change replaces)
 * and extracts the `<style data-mantine-styles>` payload. We assert `buildMantineCssVariablesHtml`
 * reproduces it string-for-string, for every color scheme, for both the real app theme and
 * synthetic themes that exercise custom colors / resolvers.
 */

// Extract the `__html` of the `<style data-mantine-styles ...>` tag that Mantine renders.
// Mantine sets `dangerouslySetInnerHTML`, so the CSS text is emitted verbatim (only `<`, `>`,
// `&` inside a <style> would be entity-encoded by React — Mantine's CSS-var payload contains
// none of those characters, so the extracted text is the exact injected string).
function renderRealMantineCssVars(
  themeOverride: MantineThemeOverride,
  colorScheme: MantineColorScheme,
  extraProps: Record<string, unknown> = {}
): string {
  const html = renderToStaticMarkup(
    createElement(MantineProvider, {
      theme: themeOverride,
      defaultColorScheme: colorScheme,
      // getRootElement must return undefined on the server (matches app SSR).
      getRootElement: () => undefined,
      ...extraProps,
      children: null,
    })
  );

  // Pin to the CSS-VARIABLES style tag (`data-mantine-styles="true"`), NOT the global-classes
  // tag (`data-mantine-styles="classes"`) that `MantineClasses` also renders. When Mantine
  // dedupes every variable away (e.g. the pure default theme), it renders NO css-vars tag —
  // which must equal our `buildMantineCssVariablesHtml` returning `''`.
  const match = html.match(/<style[^>]*data-mantine-styles="true"[^>]*>([\s\S]*?)<\/style>/);
  return match ? match[1] : '';
}

const COLOR_SCHEMES: MantineColorScheme[] = ['light', 'dark', 'auto'];

describe('buildMantineCssVariablesHtml', () => {
  describe('matches the real MantineProvider output byte-for-byte (app theme)', () => {
    for (const scheme of COLOR_SCHEMES) {
      it(`colorScheme=${scheme}`, () => {
        const real = renderRealMantineCssVars(appTheme, scheme);
        const memoized = buildMantineCssVariablesHtml(appTheme);
        expect(memoized).toBe(real);
      });
    }

    it('output is identical across all color schemes (request-invariant)', () => {
      const outputs = COLOR_SCHEMES.map((s) => renderRealMantineCssVars(appTheme, s));
      const memoized = buildMantineCssVariablesHtml(appTheme);
      for (const out of outputs) expect(out).toBe(outputs[0]);
      expect(memoized).toBe(outputs[0]);
      expect(memoized.length).toBeGreaterThan(0);
    });
  });

  describe('matches the real MantineProvider output for arbitrary themes', () => {
    const customTheme = createTheme({
      primaryColor: 'orange',
      white: '#fefefe',
      black: '#222',
      colors: {
        accent: [
          '#F4F0EA',
          '#E8DBCA',
          '#E2C8A9',
          '#E3B785',
          '#EBA95C',
          '#FC9C2D',
          '#E48C27',
          '#C37E2D',
          '#A27036',
          '#88643B',
        ],
      },
      other: { fadeIn: 'opacity 200ms ease-in' },
      respectReducedMotion: true,
    });

    for (const scheme of COLOR_SCHEMES) {
      it(`custom theme, colorScheme=${scheme}`, () => {
        const real = renderRealMantineCssVars(customTheme, scheme);
        expect(buildMantineCssVariablesHtml(customTheme)).toBe(real);
      });
    }

    it('empty theme override (pure default theme)', () => {
      const real = renderRealMantineCssVars({}, 'dark');
      expect(buildMantineCssVariablesHtml({})).toBe(real);
    });

    it('honors a custom cssVariablesResolver', () => {
      const resolver: CSSVariablesResolver = (t) => ({
        variables: { '--custom-shared': String(t.other.heroHeight ?? 400) },
        light: { '--custom-color': '#E17900' },
        dark: { '--custom-color': '#FC8C0C' },
      });
      const t = createTheme({ other: { heroHeight: 400 } });
      const real = renderRealMantineCssVars(t, 'dark', { cssVariablesResolver: resolver });
      expect(buildMantineCssVariablesHtml(t, { cssVariablesResolver: resolver })).toBe(real);
    });

    it('honors deduplicateCssVariables=false (emits color-scheme block)', () => {
      const real = renderRealMantineCssVars(appTheme, 'dark', { deduplicateCssVariables: false });
      const memoized = buildMantineCssVariablesHtml(appTheme, { deduplicateCssVariables: false });
      expect(memoized).toBe(real);
      // sanity: this path DOES append the color-scheme selector block
      expect(memoized).toContain('[data-mantine-color-scheme="dark"] { --mantine-color-scheme: dark; }');
    });
  });
});
