// Counters for the system-Redis read guard (`~/server/redis/sys-read-breaker`, behind
// `withSysReadDeadline`). Imported from `@civitai/telemetry/client` directly, like
// `model-moderation.metrics.ts`, so every module that reads sysRedis does not pull
// `~/server/prom/client`'s pool gauges. Every label value is a literal from the guard, so cardinality
// is bounded by the code.
import { registerCounterWithLabels } from '@civitai/telemetry/client';

export const sysReadGuardFailOpenCounter = registerCounterWithLabels({
  name: 'sys_read_guard_failopen_total',
  help: 'sysRedis reads through withSysReadDeadline that did not return a value, by reason (timeout|error|breaker-open)',
  labelNames: ['reason'] as const,
});

export const sysReadBreakerTransitionCounter = registerCounterWithLabels({
  name: 'sys_read_breaker_transitions_total',
  help: 'sysRedis read circuit breaker state transitions, by the state entered',
  labelNames: ['to'] as const,
});
