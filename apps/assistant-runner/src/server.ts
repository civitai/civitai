import { APP_ASSISTANT_DEFAULT_MODEL, isAppAssistantModel } from '@civitai/app-assistant';
import { configureChat } from '@civitai/components-chat/core';

import { buildApp, loggerOptions } from './app';
import { CivitaiAppFeedback } from './app-assistant/app-feedback';
import { CivitaiDevTunnels } from './app-assistant/dev-tunnel';
import { PreviewRestarter } from './app-assistant/preview-restart';
import { AppAssistantTools } from './app-assistant/provider';
import { loadConfig } from './config';
import { OrchestrationConversationStore } from './conversation-store';
import { AdvisoryLock } from './core/advisory-lock';
import { RunCredentials } from './credentials';
import { RunGrants } from './grants';
import { PgModelCalls } from './model-calls';
import type { ConversationStore, Logger, ModelProvider, ToolProvider } from './core/interfaces';
import { TokenMinter } from './minter';
import { OrchestrationClient } from './orchestration';
import { OrchestrationModels } from './orchestration-model';
import { createPool } from './core/pg-pool';
import { Runner } from './core/runner';
import { createTokenVerifier, viewerAuthenticator } from './tokens';
import {
  noTools,
  unconfiguredModel,
  unconfiguredStore,
  unconfiguredTools,
} from './core/unconfigured';

const config = loadConfig();
/** Why a start is refused when the runner has no sandbox service (`SANDBOX_URL`). */
const TOOLS_NOT_SET_UP =
  'Replies on the server are not set up yet (App Assistant’s tools are missing there), so this reply could not start.';
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
const grants = new RunGrants(pool, log);
/** Which orchestration workflow each model request was sent as: on the same pool, ids only. */
const modelCalls = new PgModelCalls(pool);
/**
 * Conversation locks on a pool of their own: a lock holds its connection while the write it guards
 * looks up grants on the pool above, so sharing one pool could leave every connection held by a
 * lock owner waiting for another. A waiter that gets no connection in time fails, not hangs.
 */
// Sized as RUN_WORKER_CONCURRENCY clamped to 8..32 connections: each run has at most one save in
// flight, plus a patch now and then, so up to 32 runs never wait for a lock connection, and past 32
// the excess waits up to 60 s. A lock is held for one orchestration read and up to three writes,
// never across a mint (the store mints before it locks).
const lockPool = createPool(
  {
    connectionString: config.databaseUrl,
    max: Math.min(32, Math.max(8, config.workerConcurrency)),
    connectionTimeoutMillis: 60_000,
  },
  'runner-locks'
);

let models: ModelProvider = unconfiguredModel;
let store: ConversationStore = unconfiguredStore;
let tools: ToolProvider = unconfiguredTools;
let previews: PreviewRestarter | undefined;
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
    calls: modelCalls,
    log,
  });
  store = new OrchestrationConversationStore({
    orchestration,
    tokens: (userId, conversationId) => credentials.forConversation(userId, conversationId),
    lock: new AdvisoryLock(lockPool),
    log,
  });
  // The live preview's tunnels, which civitai opens for a run's user: each call reads the run's
  // grant from the grants table inside its own fetch, as a mint does.
  const devTunnels = new CivitaiDevTunnels({
    civitaiUrl: civitai.civitaiUrl,
    secret: civitai.secret,
    log,
  });
  // The open app's review and user feedback, which civitai reads as a run's user: each call reads
  // the run's grant inside its own fetch, as the dev tunnel's do.
  const appFeedback = new CivitaiAppFeedback({
    civitaiUrl: civitai.civitaiUrl,
    secret: civitai.secret,
    log,
  });
  // App Assistant's tools and gate. Without the sandbox service every start is refused (below).
  tools = civitai.sandboxUrl
    ? new AppAssistantTools({
        sandboxUrl: civitai.sandboxUrl,
        tokens: (runId) => credentials.forRun(runId),
        devTunnels: (runId) => devTunnels.forRun(() => grants.forRun(runId)),
        appFeedback: (runId, signal) => appFeedback.forRun(() => grants.forRun(runId), signal),
        log,
      })
    : noTools;
  // The page's Restart preview: the request's own preview grant, for that request only.
  if (civitai.sandboxUrl)
    previews = new PreviewRestarter({
      sandboxUrl: civitai.sandboxUrl,
      forGrant: (grant) => ({
        tokens: credentials.forGrant(grant),
        tunnels: devTunnels.forRun(async () => grant),
      }),
      log,
    });
}

const runner = new Runner({
  models,
  tools,
  store,
  grants,
  modelCalls,
  log,
  wallClockMs: config.wallClockMs,
  stopGraceMs: config.stopGraceMs,
  // Serving viewers without the sandbox service would answer App Assistant with no tools at all.
  ...(civitai && !civitai.sandboxUrl ? { startRefusal: TOOLS_NOT_SET_UP } : {}),
  // A chat that follows the page's default is not saved as having picked it.
  defaultModel: APP_ASSISTANT_DEFAULT_MODEL,
});

// Without civitai's public key every run-API request is refused (401), so nothing reaches the
// unconfigured services above.
const verifier = civitai ? createTokenVerifier(civitai.publicKey) : undefined;
const app = buildApp({
  service: runner,
  // Only the models App Assistant's page offers: any other id is refused (400).
  acceptsModel: isAppAssistantModel,
  ...(verifier ? { authenticator: viewerAuthenticator(verifier), grants: verifier } : {}),
  ...(previews ? { previews } : {}),
  basePath: config.basePath,
  logger: loggerOptions(config.logLevel),
});

async function main(): Promise<void> {
  runner.register();
  // Before DBOS launches: the runs it recovers read their grants at once.
  await grants.init();
  await modelCalls.init();
  await runner.launch({
    databaseUrl: config.databaseUrl,
    executorId: config.executorId,
    workerConcurrency: config.workerConcurrency,
    logLevel: config.logLevel,
  });
  runner.startMaintenance({ retentionMs: config.retentionMs, intervalMs: MAINTENANCE_INTERVAL_MS });
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    {
      executorId: config.executorId,
      basePath: config.basePath,
      serving: Boolean(civitai),
      tools: Boolean(civitai?.sandboxUrl),
    },
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
