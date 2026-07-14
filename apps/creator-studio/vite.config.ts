import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // SvelteKit/Vite load .env into $env/dynamic/private, NOT into process.env — but the @civitai/*
  // packages read process.env DIRECTLY (loadDbEnv / loadAuthEnv). Load the .env files into
  // process.env here so they see config in dev + build. Fills gaps only, so real environment
  // variables still win. (Production runs from real env vars / `node --env-file`.)
  const fileEnv = loadEnv(mode, process.cwd(), ''); // '' = all vars, not just VITE_-prefixed
  for (const key in fileEnv) process.env[key] ??= fileEnv[key];

  return {
    plugins: [tailwindcss(), sveltekit()],
    // @civitai/* packages ship raw TS (main: ./src/index.ts) — let Vite transpile them.
    // (Their deps like pg/kysely/jose stay external/node_modules.)
    ssr: {
      noExternal: [
        '@civitai/auth',
        '@civitai/axiom',
        '@civitai/brand',
        '@civitai/buzz',
        '@civitai/clickhouse',
        '@civitai/db',
        '@civitai/db-schema',
        '@civitai/redis',
        '@civitai/ui',
      ],
    },
  };
});
