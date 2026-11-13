// Counters for the system-Redis read guard (`~/server/redis/sys-read-breaker`, behind
// `withSysReadDeadline` / `withSysReadBreaker`). Imported from `@civitai/telemetry/client` directly, like
// `model-moderation.metrics.ts`, so every module that reads sysRedis does not pull
// `~/server/prom/client`'s pool gauges. Every label value is a literal from the guard, so cardinality
// is bounded by the code.
import { registerCounterWithLabels } from '@civitai/telemetry/client';

export const sysReadGuardRejectionCounter = registerCounterWithLabels({
  name: 'sys_read_guard_rejections_total',
  help: 'sysRedis reads through withSysReadDeadline or withSysReadBreaker that rejected instead of returning a value, by reason (timeout|error|breaker-open). Each caller decides whether a rejection fails open or closed.',
  labelNames: ['reason'] as const,
});

export const sysReadBreakerTransitionCounter = registerCounterWithLabels({
  name: 'sys_read_breaker_transitions_total',
  help: 'sysRedis read circuit breaker state transitions, by the state entered',
  labelNames: ['to'] as const,
});
