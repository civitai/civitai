import { z } from 'zod';

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
  NODE_ENV: z.string().optional(),
});

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
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const parsed = env.parse(source);
  if (parsed.NODE_ENV === 'production' && !parsed.RUNNER_EXECUTOR_ID) {
    throw new Error(
      'RUNNER_EXECUTOR_ID is required in production (a stable id per replica, e.g. the pod name)'
    );
  }
  return {
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
