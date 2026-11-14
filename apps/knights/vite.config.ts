import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  for (const key in fileEnv) process.env[key] ??= fileEnv[key];

  return {
    plugins: [sveltekit()],
    server: { watch: { ignored: ['**/*.tmp.*'] } },
    ssr: {
      noExternal: [
        '@civitai/auth',
        '@civitai/axiom',
        '@civitai/brand',
        '@civitai/buzz',
        '@civitai/db',
        '@civitai/db-schema',
        '@civitai/flipt',
        '@civitai/notifications',
        '@civitai/redis',
        '@civitai/shared',
      ],
    },
  };
});
