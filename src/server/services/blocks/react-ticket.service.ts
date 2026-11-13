import { createHmac, timingSafeEqual } from 'crypto';

import { USER_SUB_RE } from '~/server/services/block-token-subject';
import {
  REACT_TICKET_MAX_LENGTH,
  REACT_TICKET_TTL_SECONDS,
  type AppReactionEntityType,
} from '~/shared/constants/block-reaction.constants';

/**
 * Provenance tickets for app reactions.
 *
 * A block may only react to an entity a block endpoint actually SERVED it, for the viewer it
 * was served to. A host-observed "ids I showed this block" set cannot express that: blocks fetch
 * images directly with their own token, so the host never sees those responses. Instead the
 * serving endpoint attaches a `reactTicket` to each entity, and `blocks.setReactionFromApp`
 * refuses an id without a valid one.
 *
 * A ticket is an HMAC over `react-ticket:v1:<entityType>:<entityId>:<appBlockId>:<sub>:<exp>`.
 * The verifier already knows everything but `exp` from the request and the verified token, so
 * the wire form is only `v1.<exp>.<sig>`. A ticket issued to one app, or to one viewer, does not
 * verify for another: both are inside the signed string.
 *
 * Keyed by `NEXTAUTH_SECRET`, as `review-session.ts` and the dev-tunnel session are, with its own
 * domain prefix so this HMAC can never be confused with another the app signs over the same
 * secret. No new secret to provision.
 *
 * Pure apart from the secret lookup, which is injectable for tests.
 */

const DOMAIN_PREFIX = 'react-ticket:v1';
const WIRE_VERSION = 'v1';

type TicketSubject = {
  entityType: AppReactionEntityType;
  entityId: number;
  appBlockId: string;
  /** The token subject, verbatim (`user:<id>`). */
  sub: string;
};

function signingString(t: TicketSubject, exp: number): string {
  return `${DOMAIN_PREFIX}:${t.entityType}:${t.entityId}:${t.appBlockId}:${t.sub}:${exp}`;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(secret: string, value: string): string {
  return base64url(createHmac('sha256', secret).update(value).digest());
}

function resolveSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set');
  return secret;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function signReactTicket(
  subject: TicketSubject,
  opts?: { secret?: string; nowSeconds?: number; ttlSeconds?: number }
): string {
  const secret = opts?.secret ?? resolveSecret();
  const exp = (opts?.nowSeconds ?? nowSec()) + (opts?.ttlSeconds ?? REACT_TICKET_TTL_SECONDS);
  return `${WIRE_VERSION}.${exp}.${sign(secret, signingString(subject, exp))}`;
}

export type ReactTicketVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'mismatch' };

/** Never throws on input: anything that is not a valid ticket for `subject` is `ok: false`. */
export function verifyReactTicket(
  ticket: unknown,
  subject: TicketSubject,
  opts?: { secret?: string; nowSeconds?: number }
): ReactTicketVerdict {
  if (typeof ticket !== 'string' || ticket.length === 0) return { ok: false, reason: 'missing' };
  if (ticket.length > REACT_TICKET_MAX_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== WIRE_VERSION || !/^[0-9]{1,12}$/.test(parts[1])) {
    return { ok: false, reason: 'malformed' };
  }
  const exp = Number.parseInt(parts[1], 10);
  const now = opts?.nowSeconds ?? nowSec();
  if (exp <= now) return { ok: false, reason: 'expired' };

  let secret: string;
  try {
    secret = opts?.secret ?? resolveSecret();
  } catch {
    return { ok: false, reason: 'mismatch' };
  }
  const expected = Buffer.from(sign(secret, signingString(subject, exp)));
  const provided = Buffer.from(parts[2]);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true };
}

/**
 * The ticket a block endpoint attaches to one image it serves, or `undefined` when it must not
 * attach one: an anonymous token (there is no viewer to bind it to), or no signing secret.
 *
 * Attached whatever scopes the token carries. A ticket grants nothing on its own — the write
 * still needs the consented scope, the session and the flag — and binding it to the scope would
 * strand the images an app fetched BEFORE the viewer granted it.
 */
export function reactTicketForImage(
  claims: { sub: string; appBlockId: string },
  imageId: number,
  opts?: { secret?: string; nowSeconds?: number }
): string | undefined {
  // The subject grammar the token verifier enforces; `anon` (and anything malformed) fails it.
  if (!USER_SUB_RE.test(claims.sub) || !claims.appBlockId) return undefined;
  try {
    return signReactTicket(
      { entityType: 'image', entityId: imageId, appBlockId: claims.appBlockId, sub: claims.sub },
      opts
    );
  } catch {
    // No secret configured: serve the images without tickets. Reacting then fails closed at
    // the write; the read the block asked for is not broken by a feature it may not use.
    return undefined;
  }
}
