import { availableParallelism } from 'node:os';
import { DEFAULT_MAX_QUEUE } from './limits.ts';

/** Runtime configuration, from the environment. See .env.example. Fails fast on a bad value. */
export type Config = {
  secret: string;
  host: string;
  port: number;
  metricsPort: number;
  poolSize: number;
  maxQueue: number;
};

function int(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.STORAGE_HOOK_RUNNER_SECRET ?? '';
  // The same secret signs requests (civitai) and responses (here); a short one is a config bug.
  if (secret.length < 32) throw new Error('STORAGE_HOOK_RUNNER_SECRET must be at least 32 chars');
  return {
    secret,
    host: env.HOST || '0.0.0.0',
    port: int('PORT', 8080, env),
    metricsPort: int('METRICS_PORT', 9091, env),
    // One worker per CPU the container may use. Set POOL_SIZE to the CPU limit when
    // availableParallelism() reports the node's cores rather than the container's quota.
    poolSize: int('POOL_SIZE', availableParallelism(), env),
    maxQueue: int('MAX_QUEUE', DEFAULT_MAX_QUEUE, env),
  };
}
