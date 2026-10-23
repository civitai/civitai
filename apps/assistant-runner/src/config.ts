import { z } from 'zod';

import { DEFAULT_CONTEXT_BUDGET_TOKENS, DEFAULT_MAX_STEPS } from './defaults';

const env = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** The runner's own Postgres database: DBOS keeps its workflows, queue and journals here. */
  DATABASE_URL: z.string().min(1),
  /**
   * This process's DBOS executor id. DBOS recovers a crashed process's runs only in a process with the
   * same id, so each replica needs a stable, distinct one (a StatefulSet pod name).
   */
  RUNNER_EXECUTOR_ID: z.string().min(1).optional(),
  /** The longest one run may take before it ends `ran_out`. */
  RUN_WALL_CLOCK_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 60 * 60 * 1000),
  /** How long a Stop waits for the run to end by itself before cancelling it outright. */
  RUN_STOP_GRACE_MS: z.coerce.number().int().positive().default(5000),
  /** The most runs one process works on at once (across users; each user has at most one). */
  RUN_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(50),
  /** Ended runs (their journals and workflows) are deleted after this many days. */
  RUN_RETENTION_DAYS: z.coerce.number().positive().default(7),
  /** On SIGTERM, how long runs in this process get to finish before it exits (they resume on restart). */
  RUN_SHUTDOWN_GRACE_MS: z.coerce.number().int().nonnegative().default(10_000),
  /**
   * The path the run API is served under, e.g. `/api/assistant-runner` when the page reaches the
   * runner on its own origin. Empty serves it at the root. `/healthz` and `/readyz` stay at the root.
   */
  RUNNER_BASE_PATH: z
    .string()
    .regex(/^(\/[A-Za-z0-9._~-]+)*$/, 'a path like /api/assistant-runner, with no trailing slash')
    .default(''),
  /**
   * civitai's public key (SPKI PEM) for the viewer tokens and run grants it signs. Unset, every
   * run-API request is refused (401) and nothing below is used.
   */
  RUNNER_TOKEN_PUBLIC_KEY: z.string().optional(),
  /**
   * The runner's own secret, which civitai checks when the runner trades a grant for a token: at
   * least 32 characters (after trimming), as civitai requires of its copy.
   */
  RUNNER_SECRET: z.string().optional(),
  /** civitai's base URL, where the runner trades grants for tokens. */
  CIVITAI_URL: z.url().optional(),
  /** Orchestration's base URL: the model (`/v1/chat/completions`) and the conversation store. */
  ORCHESTRATION_URL: z.url().optional(),
  /**
   * The hosted sandbox service's base URL (civitai's `APP_ASSISTANT_SANDBOX_URL`): App Assistant's
   * tools. Unset, a reply has no tools (words only), as before B2.
   */
  SANDBOX_URL: z.url().optional(),
  /**
   * The most steps (paid model requests) one reply takes, as the page's `configureChat({ maxSteps })`.
   * App Assistant's page uses 1000.
   */
  RUN_MAX_STEPS: z.coerce.number().int().min(2).max(1000).default(DEFAULT_MAX_STEPS),
  /** About how many tokens of earlier conversation a reply sends. App Assistant's page uses 64000. */
  RUN_CONTEXT_BUDGET_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_CONTEXT_BUDGET_TOKENS),
  NODE_ENV: z.string().optional(),
});

/** What the runner needs to serve viewers: all of it, or none (then it refuses every request). */
export interface CivitaiConfig {
  publicKey: string;
  secret: string;
  civitaiUrl: string;
  orchestrationUrl: string;
  /** `undefined` when unset: replies then have no tools. */
  sandboxUrl: string | undefined;
}

export type RunnerConfig = {
  port: number;
  host: string;
  logLevel: z.infer<typeof env>['LOG_LEVEL'];
  databaseUrl: string;
  executorId: string;
  wallClockMs: number;
  stopGraceMs: number;
  workerConcurrency: number;
  retentionMs: number;
  shutdownGraceMs: number;
  basePath: string;
  /** `undefined` when no public key is set: the runner then serves nobody. */
  civitai: CivitaiConfig | undefined;
  maxSteps: number;
  contextBudgetTokens: number;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const parsed = env.parse(source);
  if (parsed.NODE_ENV === 'production' && !parsed.RUNNER_EXECUTOR_ID) {
    throw new Error(
      'RUNNER_EXECUTOR_ID is required in production (a stable id per replica, e.g. the pod name)'
    );
  }
  return {
    basePath: parsed.RUNNER_BASE_PATH,
    civitai: civitaiConfig(parsed),
    maxSteps: parsed.RUN_MAX_STEPS,
    contextBudgetTokens: parsed.RUN_CONTEXT_BUDGET_TOKENS,
    port: parsed.PORT,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    executorId: parsed.RUNNER_EXECUTOR_ID ?? 'local',
    wallClockMs: parsed.RUN_WALL_CLOCK_MS,
    stopGraceMs: parsed.RUN_STOP_GRACE_MS,
    workerConcurrency: parsed.RUN_WORKER_CONCURRENCY,
    retentionMs: parsed.RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    shutdownGraceMs: parsed.RUN_SHUTDOWN_GRACE_MS,
  };
}

/** The shortest runner secret either side accepts. */
export const MIN_SECRET_LENGTH = 32;

function civitaiConfig(parsed: z.infer<typeof env>): CivitaiConfig | undefined {
  // A PEM pasted into one line of an env file carries its newlines as `\n`.
  const publicKey = parsed.RUNNER_TOKEN_PUBLIC_KEY?.trim().replace(/\\n/g, '\n');
  if (!publicKey) return undefined;
  const secret = parsed.RUNNER_SECRET?.trim();
  if (secret && secret.length < MIN_SECRET_LENGTH)
    throw new Error(`RUNNER_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  const missing = [
    !secret && 'RUNNER_SECRET',
    !parsed.CIVITAI_URL && 'CIVITAI_URL',
    !parsed.ORCHESTRATION_URL && 'ORCHESTRATION_URL',
  ].filter(Boolean);
  // Half a configuration would take runs it can never pay for or save: refuse to start instead.
  if (missing.length)
    throw new Error(`RUNNER_TOKEN_PUBLIC_KEY is set, so these are required: ${missing.join(', ')}`);
  return {
    publicKey,
    secret: secret!,
    civitaiUrl: parsed.CIVITAI_URL!,
    orchestrationUrl: parsed.ORCHESTRATION_URL!,
    sandboxUrl: parsed.SANDBOX_URL,
  };
}
