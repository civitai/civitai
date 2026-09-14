import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // SvelteKit/Vite load .env into $env/dynamic/private, NOT into process.env — but the @civitai/*
  // packages read process.env DIRECTLY (loadAuthEnv). Load the .env files into process.env here so
  // they see config in dev + build. Fills gaps only, so real environment variables still win.
  const fileEnv = loadEnv(mode, process.cwd(), ''); // '' = all vars, not just VITE_-prefixed
  for (const key in fileEnv) process.env[key] ??= fileEnv[key];

  return {
    plugins: [tailwindcss(), sveltekit()],

    // Editors write-then-rename `foo.tmp.*` files; HMR picking up the transient file crashes the
    // dev server.
    server: { watch: { ignored: ['**/*.tmp.*'] } },

    // The workspace @civitai/* packages ship raw TS (main: ./src/index.ts). @civitai/client is a
    // built ESM package whose index.js bare-re-exports a directory (`export * from './generated'`)
    // with no `exports` map, which Node's SSR resolver rejects (ERR_UNSUPPORTED_DIR_IMPORT). Both
    // need Vite to bundle them rather than hand them to Node.
    ssr: {
      noExternal: [
        '@civitai/auth',
        '@civitai/brand',
        '@civitai/client',
        '@civitai/db',
        '@civitai/db-schema',
        '@civitai/redis',
        '@civitai/shared',
        '@civitai/ui',
      ],
    },
  };
});
