const fontFamily = [
  '-apple-system',
  'BlinkMacSystemFont',
  '"Segoe UI"',
  'Roboto',
  'Helvetica',
  'Arial',
  'sans-serif',
];

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],
  // Dark-mode only — the palette below IS the dark theme, so there's no light variant to toggle.
  theme: {
    extend: {
      fontFamily: {
        sans: fontFamily,
      },
      colors: {
        // Mirrors the main civitai app's Mantine theme (src/providers/ThemeProvider.tsx).
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
      },
    },
  },
  plugins: [],
};
