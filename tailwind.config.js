const plugin = require('tailwindcss/plugin')
const colors = require('tailwindcss/colors')

const breakpoints = {
  xs: '576px',
  sm: '768px',
  md: '992px',
  lg: '1200px',
  xl: '1400px',
}

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}',],
  darkMode: 'selector',
  important: 'body',
  experimental: {
    optimizeUniversalDefaults: true,
  },
  theme: {
    screens: breakpoints,
    extend: {
      textShadow: {
        sm: '0 1px 2px var(--tw-shadow-color)',
        default: '0 2px 4px var(--tw-shadow-color)',
      },
      // for container queries
      containers: breakpoints,
      width: breakpoints,
      maxWidth: breakpoints,
      minWidth: breakpoints,
      container: {
        padding: '1rem',
        center: true,
      },
      colors: {
        white: '#fefefe',
        black: '#222222',
        dark: {
          0: '#C1C2C5',
          1: '#A6A7AB',
          2: '#8c8fa3',
          3: '#5C5F66',
          4: '#373A40',
          5: '#2C2E33',
          6: '#25262B',
          7: '#1A1B1E',
          8: '#141517',
          9: '#101113',
        },
        gray: {
          0: '#f8f9fa',
          1: '#f1f3f5',
          2: '#e9ecef',
          3: '#dee2e6',
          4: '#ced4da',
          5: '#adb5bd',
          6: '#868e96',
          7: '#495057',
          8: '#343a40',
          9: '#212529',
        },
        yellow: {
          0: '#FFF9DB',
          1: '#FFF3BF',
          2: '#FFEC99',
          3: '#FFE066',
          4: '#FFD43B',
          5: '#FCC419',
          6: '#FAB005',
          7: '#F59F00',
          8: '#F08C00',
          9: '#E67700',
        },
        green: {
          0: '#EBFBEE',
          1: '#D3F9D8',
          2: '#B2F2BB',
          3: '#8CE99A',
          4: '#69DB7C',
          5: '#51CF66',
          6: '#40C057',
          7: '#37B24D',
          8: '#2F9E44',
          9: '#2B8A3E',
        },
        blue: {
          0: '#E7F5FF',
          1: '#D0EBFF',
          2: '#A5D8FF',
          3: '#74C0FC',
          4: '#4DABF7',
          5: '#339AF0',
          6: '#228BE6',
          7: '#1C7ED6',
          8: '#1971C2',
          9: '#1864AB',
        },
        red: {
          0: '#fff5f5',
          1: '#ffe3e3',
          2: '#ffc9c9',
          3: '#ffa8a8',
          4: '#ff8787',
          5: '#ff6b6b',
          6: '#fa5252',
          7: '#f03e3e',
          8: '#e03131',
          9: '#c92a2a',
        },
        orange: {
          0: '#fff4e6',
          1: '#ffe8cc',
          2: '#ffd8a8',
          3: '#ffc078',
          4: '#ffa94d',
          5: '#ff922b',
          6: '#fd7e14',
          7: '#f76707',
          8: '#e8590c',
          9: '#d9480f',
        },
        lime: {
          0: '#f4fce3',
          1: '#e9fac8',
          2: '#d8f5a2',
          3: '#c0eb75',
          4: '#a9e34b',
          5: '#94d82d',
          6: '#82c91e',
          7: '#74b816',
          8: '#66a80f',
          9: '#5c940d',
        }
      },
      keyframes: {
        wiggle: {
          '0%, 100%': {transform: 'rotate(-3deg)'},
          '50%': {transform: 'rotate(3deg)'},
        }
      },
      animation: {
        wiggle: 'wiggle 1s ease-in-out infinite',
      },
    },
  },
  plugins: [
    require('./src/tailwind/container-queries'),
    plugin(function ({matchUtilities, theme, addUtilities, addVariant, e}) {
      matchUtilities(
        {
          'text-shadow': (value) => ({
            textShadow: value,
          }),
        },
        {values: theme('textShadow')},

      ),
        addUtilities({
          '.aspect-portrait': {
            aspectRatio: '7 / 9'
          },
          '.card': {},
          '.absolute-center': {},
          '.scrollbar-none': {
            scrollbarWidth: 'none',
            '::-webkit-scrollbar': {
              display: 'none',
            },
          },
          '.scrollbar-thin': {
            scrollbarWidth: 'thin'
          }
        }),
        addVariant('not-first', ({modifySelectors, separator}) => {
          modifySelectors(({className}) => {
            return `.${e(`not-first${separator}${className}`)}:not(:first-child)`
          })
        }),
        addVariant('not-last', ({modifySelectors, separator}) => {
          modifySelectors(({className}) => {
            return `.${e(`not-last${separator}${className}`)}:not(:last-child)`
          })
        })
    }),
    // ...(process.env.NODE_ENV === 'production' ? { cssnano: {} } : {})
  ],
}

