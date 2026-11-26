import type { NextApiRequest } from 'next';
import { redactCredentials } from '@civitai/axiom/redact-credentials';
import { createLogWindowCap } from '@civitai/shared/log-window-cap';
import { logToAxiom } from '~/server/logging/client';
import { reconstructApiRoute } from '~/server/prom/http-errors';
import { configuredTokenValues } from '~/server/utils/admin-token';
import { getTrustedClientIp } from '~/server/utils/client-ip';
import { redactKnownValues } from '~/server/utils/redact-known-values';
import type { TokenMatchSlot } from '~/server/utils/webhook-token';

/** `header` is x-webhook-token, `admin-header` is x-admin-token. */
export type AdminAuditCredential = 'header' | 'admin-header' | 'bearer' | 'query';
export type AdminAuditOutcome = 'accepted' | 'rejected' | 'error';

export type AdminAuditEntry = {
  action: string;
  /** `admin`: the endpoint's own x-admin-token matched. */
  slot: TokenMatchSlot | 'admin' | 'none';
  /** Where a credential was sent, not which one matched: `slot` says that. */
  presented: AdminAuditCredential[];
  outcome: AdminAuditOutcome;
  status: number;
  durationMs: number;
};

// A refused caller chooses these values, so each is capped: an oversized record is dropped
// downstream, which would lose the one record that matters.
const MAX_PARAMS_CHARS = 2000;
const MAX_HEADER_CHARS = 512;

function headerValue(value: string | string[] | undefined) {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.slice(0, MAX_HEADER_CHARS);
}

function withoutTokenKey(value: unknown) {
  if (value == null) return undefined;
  // A raw (non-JSON, non-form) body could hold anything, including an unconfigured token.
  if (typeof value !== 'object') return { unparsed: typeof value, length: String(value).length };
  if (Array.isArray(value)) return value;
  const { token: _token, ...rest } = value as Record<string, unknown>;
  return rest;
}

// A flood of refused calls must not become a flood of records: past the cap, one count per window.
const refusedCap = createLogWindowCap({
  limit: 20,
  windowMs: 60_000,
  onSummary: (summary) =>
    logToAxiom({
      name: 'admin-endpoint-audit',
      type: 'info',
      message: 'refused-calls-dropped',
      payload: { outcome: 'rejected', summary: true, ...summary },
    }),
});

/**
 * One record per call to an audited admin endpoint, accepted or not; refused calls past the cap are
 * counted instead. Never throws.
 */
export function recordAdminEndpointAudit(req: NextApiRequest, entry: AdminAuditEntry): void {
  try {
    if (
      entry.outcome === 'rejected' &&
      !refusedCap.admit({ key: entry.action, clientIp: getTrustedClientIp(req) })
    )
      return;
    const secrets = configuredTokenValues();
    // Redacted before it is cut, so a cut cannot leave half a token behind.
    // Key-name redaction must run on the object: logToAxiom's own pass cannot see inside a string.
    const params = redactKnownValues(
      JSON.stringify(
        redactCredentials({ query: withoutTokenKey(req.query), body: withoutTokenKey(req.body) })
      ),
      secrets
    );
    logToAxiom({
      name: 'admin-endpoint-audit',
      type: 'info',
      message: entry.action,
      payload: redactKnownValues(
        {
          ...entry,
          route: reconstructApiRoute(req),
          method: req.method,
          // Edge-attested or the socket peer; the raw headers below are what the caller claimed.
          clientIp: getTrustedClientIp(req),
          socketIp: req.socket?.remoteAddress,
          cfConnectingIp: headerValue(req.headers['cf-connecting-ip']),
          cfRay: headerValue(req.headers['cf-ray']),
          forwardedFor: headerValue(req.headers['x-forwarded-for']),
          userAgent: headerValue(req.headers['user-agent']),
          params: params.slice(0, MAX_PARAMS_CHARS),
          paramsChars: params.length,
        },
        secrets
      ),
    });
  } catch {
    /* never throw from an audit write */
  }
}
