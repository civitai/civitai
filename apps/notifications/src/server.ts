import { buildServer } from './app';
import { startWorker } from './worker/poll-loop';
import { host, port, workerEnabled } from './env';

// Entry point. `buildServer` (app.ts) is the testable factory (no listen); this file wires the listen
// call and — only when WORKER_ENABLED=true — starts the fan-out worker (B). The producer/read API (A)
// always runs; the worker is gated so the app can deploy API-only during the migration soak while the
// external notification-server is still the sole fan-out consumer (see WORKER_ENABLED in env.ts / the
// pre-deploy checklist). vitest imports app.ts directly, so neither the port bind nor the worker runs
// under test.

async function main() {
  const app = await buildServer();
  await app.listen({ port, host });
  app.log.info(`notifications listening on ${host}:${port}`);

  const worker = workerEnabled ? startWorker() : null;
  app.log.info(
    worker ? 'notifications fan-out worker started' : 'fan-out worker DISABLED (WORKER_ENABLED!=true)'
  );

  const shutdown = (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    worker?.stop();
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
  console.error('[notifications] fatal startup error', err);
  process.exit(1);
});
