const plugin = require('tailwindcss/plugin')

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}',],

  theme: {
    screens: {
      xs: '576px',
      sm: '768px',
      md: '992px',
      lg: '1200px',
      xl: '1400px',
    },
    extend: {
      textShadow: {
        sm: '0 1px 2px var(--tw-shadow-color)',
        default: '0 2px 4px var(--tw-shadow-color)',
      },
    },
  },
  plugins: [
    require('@tailwindcss/container-queries'),
    plugin(function ({ matchUtilities, theme, addUtilities }) {
      matchUtilities(
        {
          'text-shadow': (value) => ({
            textShadow: value,
          }),
        },
        { values: theme('textShadow') },

      ),
      addUtilities({
        '.aspect-portrait': {
          aspectRatio: '7 / 9'
        },
        '.card': {}
      })
    }),
  ],
}

