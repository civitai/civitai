import { resolve, sep } from 'node:path';
import { createServer, createServerModuleRunner } from 'vite';

const appRoot = resolve(import.meta.dirname, '..');

/**
 * Runs a script through Vite's SSR module runner: `tsx scripts/vite-run.ts <script.ts> [args...]`.
 * The workspace packages are CommonJS-scoped TypeScript, so plain tsx hands an ES module only their `default` export and
 * named imports fail; Vite transforms them from source the way the build and the tests do.
 */
async function main() {
  const [script, ...args] = process.argv.slice(2);
  if (!script) throw new Error('Usage: tsx scripts/vite-run.ts <script.ts> [args...]');
  // The script reads its own arguments from process.argv.slice(2).
  process.argv = [process.argv[0], resolve(script), ...args];

  const server = await createServer({
    appType: 'custom',
    logLevel: 'error',
    plugins: [
      {
        // Scripts may import the root app's services (../../src), which resolve from the repo root where the
        // workspace packages are not installed; resolve those imports as if they came from this app.
        name: 'knights-workspace-resolve',
        enforce: 'pre',
        async resolveId(source, importer, options) {
          if (!source.startsWith('@civitai/') || !importer || importer.startsWith(appRoot + sep))
            return null;
          return this.resolve(source, resolve(appRoot, 'package.json'), {
            ...options,
            skipSelf: true,
          });
        },
      },
    ],
    server: { middlewareMode: true, hmr: false, ws: false },
    // A script run has no browser entries; skip the dependency scan, which errors when the server closes first.
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
    await runner.import(resolve(script));
  } finally {
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
