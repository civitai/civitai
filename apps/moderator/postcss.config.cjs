// Tailwind v3 + autoprefixer. Having a config here also stops PostCSS from walking up
// the monorepo to the root Next app's postcss config (Mantine preset etc.).
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
