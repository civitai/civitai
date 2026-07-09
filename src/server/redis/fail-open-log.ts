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
 *
 * - `rate-limit-write-degraded`  middleware.trpc.recordAttempt failed to
 *                            persist the rate-limit attempt counter. The
 *                            current request still completes; the user's
 *                            sliding-window quota under-counts this
 *                            attempt until the next successful write.
 *                            Distinguished from generic write-degraded so
 *                            ops can dashboard a rate-limit-specific
 *                            fail-open volume (a sustained spike means
 *                            abuse-prevention is effectively disabled).
 */
export type SysRedisFailOpenSubtype =
  | 'defaults-firing'
  | 'tracking-write-cliff'
  | 'token-mint-amplification'
  | 'read-degraded'
  | 'write-degraded'
  | 'rate-limit-write-degraded';

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
  // .catch swallows Axiom-side failures. logToAxiom internally awaits
  // axiom.ingestEvents which can reject if Axiom itself is degraded —
  // discarding the promise with `void` alone would let that rejection
  // bubble to unhandledRejection. Critical when this very logger fires
  // most: a multi-service incident (sysRedis + Axiom both down).
  //
  // Spread safeError(err) and extra FIRST: safeError returns
  // { name: e.name, ... } where e.name is "Error" / "TypeError" / etc.
  // Spreading it after the literal `name: 'sysredis-fail-open'` would
  // overwrite the alert tag, silently invalidating every Grafana query
  // that filters by `name="sysredis-fail-open"`. Same gotcha called out
  // in src/server/services/file.service.ts:338-339.
  //
  // Literal fields (name/type/subtype/fn) come LAST so they always win,
  // even if a caller accidentally passes one of those keys in `extra`.
  logToAxiom({
    ...safeError(err),
    ...extra,
    name: 'sysredis-fail-open',
    type: 'warning',
    subtype,
    fn,
  }).catch(() => {
    /* fail-open logger never blocks the request */
  });
}
