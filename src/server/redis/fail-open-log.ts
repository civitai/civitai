import { logToAxiom, safeError } from '~/server/logging/client';

/**
 * Structured tag for fail-open paths in sysRedis hot-path readers and
 * writebacks. Used by Grafana Loki alerts in talos-infra
 * (`sysredis-fail-open-alerts-configmap.yaml`).
 *
 * Subtypes map to specific operational concerns:
 *
 * - `defaults-firing`        getGenerationStatus / getTrainingServiceStatus
 *                            / getCreationBlockedTags fell back to schema
 *                            defaults. The first two default to
 *                            `available=true` — if admin had disabled the
 *                            service, it now appears enabled.
 *
 * - `tracking-write-cliff`   setToken's USER_TOKENS write failed. Next
 *                            authenticated request from that user will
 *                            see !exists and force a getSessionUser DB
 *                            hit. Sustained = Postgres overload risk.
 *
 * - `token-mint-amplification`  getOrchestratorToken hGet failed →
 *                            fell through to getTemporaryUserApiKey
 *                            (1 insert + 2 deleteMany on ApiKey).
 *
 * - `read-degraded`          Any other fail-open read that returns a
 *                            sensible default (e.g. {}, []).
 *
 * - `write-degraded`         Any other best-effort writeback that
 *                            swallowed a sysRedis error.
 */
export type SysRedisFailOpenSubtype =
  | 'defaults-firing'
  | 'tracking-write-cliff'
  | 'token-mint-amplification'
  | 'read-degraded'
  | 'write-degraded';

/**
 * Emit a structured fail-open warning. Fire-and-forget — never blocks
 * the calling request even if Axiom is down. In civitai-dp-prod with
 * `LOG_ERRORS_TO_STDOUT=true`, the same payload also lands on stderr
 * as JSON for Loki ingest + Grafana alerting.
 *
 * Schema (Axiom + Loki):
 *   { name: "sysredis-fail-open", type: "warning", subtype, fn,
 *     ...safeError(err), ...extra }
 *
 * Notable extra fields by convention:
 *   - userId: number    when the calling context has the user
 *   - tokenId: string   token-refresh / setToken paths
 *   - event: string     base.event.ts callers
 *   - wordlist/urllist: string  moderation-utils inner loops
 */
export function logSysRedisFailOpen(
  subtype: SysRedisFailOpenSubtype,
  fn: string,
  err: unknown,
  extra?: Record<string, unknown>
): void {
  void logToAxiom({
    name: 'sysredis-fail-open',
    type: 'warning',
    subtype,
    fn,
    ...extra,
    ...safeError(err),
  });
}
