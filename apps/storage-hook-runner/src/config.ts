import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { DEFAULT_MAX_QUEUE, REMIX_DEFAULT_MAX_PER_APP, defaultMaxPerApp } from './limits.ts';

/** The one signed route a process serves: `check` is /v1/check, `remix` is /v1/remix/replay. */
export type RunnerMode = 'check' | 'remix';

/** Runtime configuration, from the environment. See .env.example. Fails fast on a bad value. */
export type Config = {
  secret: string;
  mode: RunnerMode;
  host: string;
  port: number;
  metricsPort: number;
  poolSize: number;
  maxQueue: number;
  maxPerApp: number;
};

/**
 * Workers for a cgroup v2 `cpu.max` ("<quota> <period>" or "max <period>"): ⌈quota / period⌉,
 * never more than the cores Node sees and never less than 1. Without a quota (absent, "max", or
 * unreadable) it is the core count. `availableParallelism()` alone reports the NODE's cores, not
 * the container's CPU limit, which would start one worker per node core in a 1-CPU pod.
 */
export function poolSizeFromCpuMax(cpuMax: string | undefined, cores: number): number {
  const m = cpuMax?.trim().match(/^(\d+)\s+(\d+)$/);
  if (!m) return Math.max(1, cores);
  const quota = Number(m[1]);
  const period = Number(m[2]);
  if (quota <= 0 || period <= 0) return Math.max(1, cores);
  return Math.max(1, Math.min(cores, Math.ceil(quota / period)));
}

function readCpuMax(): string | undefined {
  try {
    return readFileSync('/sys/fs/cgroup/cpu.max', 'utf8');
  } catch {
    return undefined;
  }
}

function int(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

/**
 * The shared HMAC secret as both sides use it: surrounding whitespace removed, so a trailing
 * newline from a secret file or an env editor signs and verifies the same. 🔴 The civitai caller
 * applies the identical rule (`normalizeHookRunnerSecret` in doc-store-hook.ts); a seam test there
 * pins the two equal.
 */
export function normalizeRunnerSecret(raw: string | undefined): string {
  return (raw ?? '').trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = normalizeRunnerSecret(env.STORAGE_HOOK_RUNNER_SECRET);
  // The same secret signs requests (civitai) and responses (here); a short one is a config bug.
  if (secret.length < 32) throw new Error('STORAGE_HOOK_RUNNER_SECRET must be at least 32 chars');
  // Required, so a process never serves unreviewed remix code from the permission-check pool.
  const mode = env.RUNNER_MODE;
  if (mode !== 'check' && mode !== 'remix') throw new Error('RUNNER_MODE must be check or remix');
  const maxQueue = int('MAX_QUEUE', DEFAULT_MAX_QUEUE, env);
  return {
    secret,
    mode,
    host: env.HOST || '0.0.0.0',
    port: int('PORT', 8080, env),
    metricsPort: int('METRICS_PORT', 9091, env),
    // One worker per CPU the container may use: the cgroup v2 CPU quota when there is one, else
    // the cores Node sees. POOL_SIZE overrides it.
    poolSize: int('POOL_SIZE', poolSizeFromCpuMax(readCpuMax(), availableParallelism()), env),
    maxQueue,
    maxPerApp: int(
      'MAX_PER_APP',
      mode === 'remix' ? REMIX_DEFAULT_MAX_PER_APP : defaultMaxPerApp(maxQueue),
      env
    ),
  };
}
