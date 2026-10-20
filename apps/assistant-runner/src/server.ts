import { buildApp, loggerOptions } from './app';
import { loadConfig } from './config';
import type { Logger } from './interfaces';
import { Runner } from './runner';
import { refuseAll, unconfiguredModel, unconfiguredStore, unconfiguredTools } from './unconfigured';

const config = loadConfig();

const log: Logger = {
  info: (object, message) => app.log.info(object, message),
  warn: (object, message) => app.log.warn(object, message),
  error: (object, message) => app.log.error(object, message),
};

// TODO(PR B): the real authenticator, model, tools and conversation store. Until then every run-API
// request is refused (401), so nothing reaches the unconfigured services below.
const runner = new Runner({
  models: unconfiguredModel,
  tools: unconfiguredTools,
  store: unconfiguredStore,
  log,
  wallClockMs: config.wallClockMs,
  stopGraceMs: config.stopGraceMs,
});

const app = buildApp({
  service: runner,
  authenticator: refuseAll,
  logger: loggerOptions(config.logLevel),
});

async function main(): Promise<void> {
  runner.register();
  await runner.launch({
    databaseUrl: config.databaseUrl,
    executorId: config.executorId,
    workerConcurrency: config.workerConcurrency,
    logLevel: config.logLevel,
  });
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ executorId: config.executorId }, 'assistant-runner ready');
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  // Runs this process holds stay PENDING under its executor id; the replica that comes back with the
  // same id recovers them from their saved progress.
  try {
    await app.close();
    await runner.shutdown();
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed');
    process.exitCode = 1;
  }
  process.exit();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  app.log.error({ err: error }, 'assistant-runner failed to start');
  process.exit(1);
});
