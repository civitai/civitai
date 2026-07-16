import { buildServer } from './app';
import { assertRequiredEnv, host, port } from './env';

// Entry point. `buildServer` (app.ts) is the testable factory (no listen); this file wires the listen
// call. vitest imports app.ts directly, so the port bind never runs under test.
async function main() {
  assertRequiredEnv(); // fail-fast before we bind / go Ready
  const app = await buildServer();
  await app.listen({ port, host });
  app.log.info(`storage listening on ${host}:${port}`);

  const shutdown = (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    app
      .close()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[storage] fatal startup error', err);
  process.exit(1);
});
