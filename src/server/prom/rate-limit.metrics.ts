import client from 'prom-client';
import { PROM_PREFIX } from '@civitai/telemetry/client';

/**
 * Which path decided each rate-limit claim that reached the store: `script` (the atomic claim),
 * `precheck_refused` (refused by the read before the script), `fallback` (the script errored and
 * the read-then-write path decided), `degraded` (the store did not answer in time; the local count
 * decided). After a deploy, `script` should carry the traffic and `fallback` stay near zero.
 */
export type RateLimitClaimPath = 'script' | 'precheck_refused' | 'fallback' | 'degraded';

const NAME = PROM_PREFIX + 'rate_limit_claim_path_total';

export const rateLimitClaimPathCounter: client.Counter<'path'> =
  (client.register.getSingleMetric(NAME) as client.Counter<'path'> | undefined) ??
  new client.Counter({
    name: NAME,
    help: 'Rate-limit claims by the path that decided them: script, precheck_refused, fallback, degraded.',
    labelNames: ['path'] as const,
  });
