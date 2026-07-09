// Axiom logger for the auth hub via @civitai/axiom. The hub had no Axiom path, so its captcha/auth telemetry
// was invisible outside the cluster (ClickUp 868k9gug8). @civitai/axiom writes a structured stderr line
// (→ Alloy → Loki) on every prod call regardless of config, and additionally dual-writes to Axiom when
// AXIOM_TOKEN/AXIOM_ORG_ID are set. Default the datastream to `civitai-prod` so hub events are queryable
// alongside the main app's `auth-flow` logs rather than in a separate dataset.
import { createAxiomLogger, safeError } from '@civitai/axiom';

const logger = createAxiomLogger();

export function logToAxiom(data: Record<string, unknown>, datastream = 'civitai-prod') {
  return logger.logToAxiom(data, datastream);
}

// Fire-and-forget error logger for the hub's catch paths. Mirrors apps/notifications' logAxiomError, and
// routes to the default `civitai-prod` datastream (shared with the main app + the existing captcha path).
// Accepts an optional `extra` object so callers can attach the exact human label the Loki alerts match on
// (e.g. { event: 'unhandled server error' }). Order matters: `extra` spreads BEFORE safeError so the marker
// survives, and safeError's name/message/stack land last. The serialized JSON line (→ Alloy → Loki) MUST
// keep those literal substrings — the datapacket-talos alerts
// `{namespace="civitai-auth"} |~ "(?i)(unhandled server error|handler error|action failed|…)" != "invalid_grant"`
// key off them. Swallows its own failure so logging can never break the request.
export function logAxiomError(error: unknown, extra?: Record<string, unknown>) {
  return logToAxiom({ type: 'error', ...extra, ...safeError(error) }).catch(() => {});
}

export { safeError };
