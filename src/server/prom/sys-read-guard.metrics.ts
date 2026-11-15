// Counters for the system-Redis read guards (`~/server/redis/sys-read-breaker`, behind
// `withSysReadDeadline` / `withSysReadBreaker` / `withRevocationReadBreaker`). Imported from
// `@civitai/telemetry/client` directly, like `model-moderation.metrics.ts`, so every module that reads
// sysRedis does not pull `~/server/prom/client`'s pool gauges. Every label value is a literal from the
// guards, so cardinality is bounded by the code.
import { registerCounterWithLabels } from '@civitai/telemetry/client';

export const sysReadGuardRejectionCounter = registerCounterWithLabels({
  name: 'sys_read_guard_rejections_total',
  help: 'sysRedis reads through withSysReadDeadline, withSysReadBreaker or withRevocationReadBreaker that rejected instead of returning a value, by guard (revocation = withRevocationReadBreaker, shared = the other two) and reason (timeout|error|breaker-open). Each caller decides whether a rejection fails open or closed.',
  labelNames: ['guard', 'reason'] as const,
});

export const sysReadBreakerTransitionCounter = registerCounterWithLabels({
  name: 'sys_read_breaker_transitions_total',
  help: 'sysRedis read circuit breaker state transitions, by breaker (shared|revocation) and the state entered',
  labelNames: ['guard', 'to'] as const,
});
