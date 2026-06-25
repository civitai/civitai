// Ported from the main app's src/server/oauth/audit-log.ts. (The original imported `dbWrite` but never
// used it — dropped here.) Structured JSON to stdout for log aggregation (Axiom, etc.); fire-and-forget.

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

  // Log as structured JSON for log aggregation (Axiom, etc.)
  console.log(`[oauth-audit] ${JSON.stringify(entry)}`);
}
