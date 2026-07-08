// Ported from the main app's src/server/oauth/audit-log.ts. (The original imported `dbWrite` but never
// used it — dropped here.) Structured JSON to stdout for log aggregation (Axiom, etc.); fire-and-forget.

import { oauthEventsTotal } from '../metrics';
import { logToAxiom } from '$lib/server/axiom';

export type OAuthEventType =
  | 'client.created'
  | 'client.updated'
  | 'client.deleted'
  | 'client.secret_rotated'
  | 'authorization.granted'
  | 'authorization.denied'
  | 'token.issued'
  | 'token.refreshed'
  | 'token.revoked'
  | 'origin.rejected';

interface OAuthAuditEvent {
  type: OAuthEventType;
  userId?: number;
  clientId?: string;
  scope?: number;
  ip?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Log OAuth events for audit trail.
 *
 * Currently logs to the application logger. In the future, this could
 * write to a dedicated audit table or ClickHouse for queryability.
 *
 * Fire-and-forget — never blocks the request.
 */
export function logOAuthEvent(event: OAuthAuditEvent): void {
  const entry = {
    timestamp: new Date().toISOString(),
    ...event,
  };

  // Dual-write to Loki (via the @civitai/axiom stderr line) + Axiom. Fire-and-forget — never blocks the
  // request; a logging failure must not affect the audited operation.
  void logToAxiom({ event: 'oauth-audit', ...entry }).catch(() => {});

  // Mirror to a bounded-cardinality counter. The label is the event type with dots→underscores
  // (e.g. token.issued → token_issued) so it's a valid, stable Prometheus label value. This is the
  // single central place every logOAuthEvent caller flows through.
  oauthEventsTotal.inc({ type: event.type.replace(/\./g, '_') });
}
