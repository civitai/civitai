import { dbWrite } from '~/server/db/client';

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
  scope?: bigint;
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
    scope: event.scope === undefined ? undefined : Number(event.scope),
  };

  // Log as structured JSON for log aggregation (Axiom, etc.)
  console.log(`[oauth-audit] ${JSON.stringify(entry)}`);
}
