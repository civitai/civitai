// @ts-check
//
// `@ts-check` above is load-bearing, not decorative. tsconfig sets `allowJs: true`
// but leaves `checkJs` unset, so a `.js` file under src/ is COMPILED BY tsc and
// TYPE-CHECKED BY NOTHING — the JSDoc annotations below would be pure decoration
// without it. Verified by mutation: injecting `(42).toUpperCase()` here is
// invisible to `tsc --noEmit` when this directive is absent, and raises TS2339
// when it is present. Do not remove it when editing this file.
//
// CommonJS on purpose. This plugin is loaded exclusively by `tailwind.config.js`, a
// CJS module, via `require()`. Node's CJS resolver cannot resolve `.ts`, so authoring
// this as TypeScript made a plain `require()` of the tailwind config throw — the whole
// project theme then silently depended on the config being loaded by a TypeScript-aware
// loader (tailwind's bundled jiti). Types are kept as JSDoc.
// NOTE: no eslint-disable here on purpose. `.eslintignore` line 1 is `*.js`, so this
// file is not linted at all and a suppression comment would be inert — documenting a
// rule that never runs. If `*.js` is ever removed from `.eslintignore`, this `require`
// will need `@typescript-eslint/no-var-requires` disabled.
const plugin = require('tailwindcss/plugin');

/**
 * @typedef {{ value: string; modifier: string | null }} VariantSortProps
 */

module.exports = plugin(
  function containerQueries({ matchUtilities, matchVariant, theme }) {
    /** @type {Record<string, string>} */
    const values = theme('containers') ?? {};

    /** @param {string} value */
    function parseValue(value) {
      const numericValue = value.match(/^(\d+\.\d+|\d+|\.\d+)\D+/)?.[1] ?? null;
      if (numericValue === null) return null;

      return parseFloat(value);
    }

    /**
     * @param {VariantSortProps} aVariant
     * @param {VariantSortProps} zVariant
     */
    function sort(aVariant, zVariant) {
      const a = parseFloat(aVariant.value);
      const z = parseFloat(zVariant.value);

      if (a === null || z === null) return 0;

      // Sort values themselves regardless of unit
      if (a - z !== 0) return a - z;

      const aLabel = aVariant.modifier ?? '';
      const zLabel = zVariant.modifier ?? '';

      // Explicitly move empty labels to the end
      if (aLabel === '' && zLabel !== '') {
        return 1;
      } else if (aLabel !== '' && zLabel === '') {
        return -1;
      }

      // Sort labels alphabetically in the English locale
      // We are intentionally overriding the locale because we do not want the sort to
      // be affected by the machine's locale (be it a developer or CI environment)
      return aLabel.localeCompare(zLabel, 'en', { numeric: true });
    }

    matchUtilities(
      {
        '@container': (value, { modifier }) => {
          return {
            'container-type': value,
            'container-name': modifier,
          };
        },
      },
      {
        values: {
          DEFAULT: 'inline-size',
          normal: 'normal',
        },
        modifiers: 'any',
      }
    );

    matchVariant(
      '@',
      (value = '', { modifier }) => {
        const parsed = parseValue(value);

        return parsed !== null ? `@container ${modifier ?? ''} (min-width: ${value})` : [];
      },
      {
        values,
        sort,
      }
    );

    matchVariant(
      '@max',
      (value = '', { modifier }) => {
        const parsed = parseValue(value);

        return parsed !== null ? `@container ${modifier ?? ''} (width < ${value})` : [];
      },
      {
        values,
        sort,
      }
    );
  },
  {
    theme: {
      containers: {
        xs: '20rem',
        sm: '24rem',
        md: '28rem',
        lg: '32rem',
        xl: '36rem',
        '2xl': '42rem',
        '3xl': '48rem',
        '4xl': '56rem',
        '5xl': '64rem',
        '6xl': '72rem',
        '7xl': '80rem',
      },
    },
  }
);
