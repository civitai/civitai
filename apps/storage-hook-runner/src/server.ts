import { createServer } from 'node:http';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createMetrics } from './metrics.ts';
import { HookPool } from './pool.ts';

// Entry point. `buildApp` (app.ts) is the testable factory; this file wires the listeners.
async function main() {
  const config = loadConfig();
  const metrics = createMetrics();
  const pool = await HookPool.start({
    size: config.poolSize,
    maxQueue: config.maxQueue,
    maxPerApp: config.maxPerApp,
    onBackstop: (appId) => metrics.workerTerminated.inc({ app: appId }),
  });
  metrics.attachPool(pool);

  const app = buildApp({ secret: config.secret, pool, metrics, logger: true });
  await app.listen({ port: config.port, host: config.host });

  // Metrics on their own port, so the request port's network policy can admit only the caller.
  const metricsServer = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metrics.registry.metrics().then(
      (text) => res.writeHead(200, { 'content-type': metrics.registry.contentType }).end(text),
      () => res.writeHead(500).end()
    );
  });
  metricsServer.listen(config.metricsPort, config.host);
  app.log.info(
    `storage-hook-runner listening on ${config.port} (metrics ${config.metricsPort}), ${config.poolSize} workers`
  );

  const shutdown = (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    metricsServer.close();
    app
      .close()
      .then(() => pool.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[storage-hook-runner] fatal startup error', err);
  process.exit(1);
});
