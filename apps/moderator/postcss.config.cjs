// Empty on purpose: Tailwind v4 is handled by @tailwindcss/vite (see vite.config.ts), not PostCSS.
// This file exists only to stop PostCSS from walking up to the monorepo root's config (the main
// app's Tailwind v3 + Mantine preset), which would otherwise process this app's CSS.
module.exports = {};
