import { buildServer } from './app';
import { startWorker } from './worker/poll-loop';
import { host, port } from './env';

// Entry point. `buildServer` (app.ts) is the testable factory (no listen); this file wires the listen
// call AND starts the fan-out worker, so the one process owns both the producer API (A) and the poll
// worker (B). vitest imports app.ts directly, so neither the port bind nor the worker runs under test.

async function main() {
  const app = await buildServer();
  await app.listen({ port, host });
  app.log.info(`notifications listening on ${host}:${port}`);

  const worker = startWorker();
  app.log.info('notifications fan-out worker started');

  const shutdown = (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    worker.stop();
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
