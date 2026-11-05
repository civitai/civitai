import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Required — see the `apps/*` note in the root vitest.config.mts.
    name: 'app:search',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Its dist uses directory imports Node's ESM loader rejects; tsup bundles it for the build.
    server: { deps: { inline: [/@civitai\/orchestration-client/] } },
  },
});
