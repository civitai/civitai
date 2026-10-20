import { configureChat } from '@civitai/components-chat/core';

import { buildApp, loggerOptions } from './app';
import { loadConfig } from './config';
import { AdvisoryLock, OrchestrationConversationStore } from './conversation-store';
import { RunCredentials } from './credentials';
import { RunGrants } from './grants';
import type { ConversationStore, Logger, ModelProvider, ToolProvider } from './interfaces';
import { TokenMinter } from './minter';
import { OrchestrationClient } from './orchestration';
import { OrchestrationModels } from './orchestration-model';
import { createPool } from './pg-pool';
import { Runner } from './runner';
import { createTokenVerifier, viewerAuthenticator } from './tokens';
import { noTools, unconfiguredModel, unconfiguredStore, unconfiguredTools } from './unconfigured';

const config = loadConfig();
const MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;

const log: Logger = {
  info: (object, message) => app.log.info(object, message),
  warn: (object, message) => app.log.warn(object, message),
  error: (object, message) => app.log.error(object, message),
};

// The step budget and history budget every reply uses, as App Assistant's page configures them.
configureChat({ maxSteps: config.maxSteps, contextBudgetTokens: config.contextBudgetTokens });

/** The runner's own table of run grants, beside DBOS's in the same database. */
const pool = createPool(
  { connectionString: config.databaseUrl, max: 8, connectionTimeoutMillis: 10_000 },
  'runner-grants'
);
const grants = new RunGrants(pool);
/**
 * Conversation locks on a pool of their own: a lock holds its connection while the write it guards
 * looks up grants on the pool above, so sharing one pool could leave every connection held by a
 * lock owner waiting for another. A waiter that gets no connection in time fails, not hangs.
 */
const lockPool = createPool(
  { connectionString: config.databaseUrl, max: 16, connectionTimeoutMillis: 60_000 },
  'runner-locks'
);

let models: ModelProvider = unconfiguredModel;
let store: ConversationStore = unconfiguredStore;
let tools: ToolProvider = unconfiguredTools;
const civitai = config.civitai;
if (civitai) {
  const credentials = new RunCredentials(
    grants,
    new TokenMinter({ civitaiUrl: civitai.civitaiUrl, secret: civitai.secret, log })
  );
  const orchestration = new OrchestrationClient(civitai.orchestrationUrl);
  models = new OrchestrationModels({
    baseUrl: civitai.orchestrationUrl,
    orchestration,
    tokens: (runId) => credentials.forRun(runId),
  });
  store = new OrchestrationConversationStore({
    orchestration,
    tokens: (userId, conversationId) => credentials.forConversation(userId, conversationId),
    lock: new AdvisoryLock(lockPool),
    log,
  });
  // TODO(B2): the sandbox MCP tools and the App Assistant gate. Until then a reply is words only.
  tools = noTools;
}

const runner = new Runner({
  models,
  tools,
  store,
  grants,
  log,
  wallClockMs: config.wallClockMs,
  stopGraceMs: config.stopGraceMs,
});

// Without civitai's public key every run-API request is refused (401), so nothing reaches the
// unconfigured services above.
const verifier = civitai ? createTokenVerifier(civitai.publicKey) : undefined;
const app = buildApp({
  service: runner,
  ...(verifier ? { authenticator: viewerAuthenticator(verifier), grants: verifier } : {}),
  basePath: config.basePath,
  logger: loggerOptions(config.logLevel),
});

async function main(): Promise<void> {
  runner.register();
  // Before DBOS launches: the runs it recovers read their grants at once.
  await grants.init();
  await runner.launch({
    databaseUrl: config.databaseUrl,
    executorId: config.executorId,
    workerConcurrency: config.workerConcurrency,
    logLevel: config.logLevel,
  });
  runner.startMaintenance({ retentionMs: config.retentionMs, intervalMs: MAINTENANCE_INTERVAL_MS });
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { executorId: config.executorId, basePath: config.basePath, serving: Boolean(civitai) },
    'assistant-runner ready'
  );
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  // Runs this process holds stay PENDING under its executor id; the replica that comes back with the
  // same id recovers them from their saved progress.
  try {
    // No new runs or streams from here; runs in flight get a bounded grace.
    await app.close();
    await runner.shutdown(config.shutdownGraceMs);
    await pool.end();
    await lockPool.end();
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
