import { resolve } from 'node:path';
import { createServer, createServerModuleRunner } from 'vite';

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
    server: { middlewareMode: true, hmr: false, ws: false },
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
