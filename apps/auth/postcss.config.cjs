// This SvelteKit app uses plain CSS — no Tailwind/Mantine. Without this file,
// PostCSS walks up the monorepo and inherits the root Next.js config (Tailwind,
// postcss-preset-mantine, etc.), which warns about empty Tailwind `content`.
// An empty config here stops that upward search.
module.exports = {};
