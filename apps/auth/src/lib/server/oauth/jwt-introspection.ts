import { decodeProtectedHeader } from 'jose';
import { env } from '$env/dynamic/private';
import { createAccessTokenJwtVerifier } from '@civitai/auth';
import { logToAxiom } from '$lib/server/axiom';
import { getExchangeResources } from './exchange-resources';
import {
  exchangeScopeCeiling,
  findExchangeClient,
  findSubjectTokenById,
  readExchangeRecord,
  scopeNames,
  userRefusal,
} from './token-exchange';

// RFC 7662 introspection of a JWT minted by the user token exchange. Active only while everything it was
// minted from still holds: the signature, the resource's lists, the exchange record, the access token it came
// from, the app and the user. Each of those failing reads as {active:false}; a lookup that cannot answer
// is `indeterminate`, which the route turns into a 503.

/** Whether `token` is a compact JWS whose header says `typ: at+jwt`. */
export function isAccessTokenJwt(token: string): boolean {
  if (token.split('.').length !== 3) return false;
  try {
    const typ = decodeProtectedHeader(token).typ;
    return typeof typ === 'string' && /^(application\/)?at\+jwt$/i.test(typ);
  } catch {
    return false;
  }
}

/** Whether `clientId` may introspect the JWTs of some registered resource. */
export async function isAnyIntrospector(clientId: string): Promise<boolean> {
  return (await getExchangeResources()).some((r) => r.introspectors.includes(clientId));
}

let verifier: ReturnType<typeof createAccessTokenJwtVerifier> | undefined;

export type JwtIntrospection =
  | { kind: 'active'; body: Record<string, unknown> }
  | { kind: 'inactive' }
  | { kind: 'indeterminate' };

function inactive(reason: string, extra?: Record<string, unknown>): JwtIntrospection {
  void logToAxiom({
    event: 'token_exchange_introspect',
    result: 'inactive',
    reason,
    ...extra,
  }).catch(() => undefined);
  return { kind: 'inactive' };
}

/** Introspect an exchanged JWT for the authenticated client `callerId`. */
export async function introspectAccessTokenJwt(
  token: string,
  callerId: string
): Promise<JwtIntrospection> {
  const issuer = env.AUTH_JWT_ISSUER;
  if (!issuer) return inactive('issuer not configured');

  let payload;
  try {
    verifier ??= createAccessTokenJwtVerifier();
    payload = await verifier(token, issuer);
  } catch (err) {
    void logToAxiom({ type: 'error', name: 'introspect-jwt-verifier', message: String(err) }).catch(
      () => undefined
    );
    return inactive('verifier not configured');
  }
  if (!payload) return inactive('signature or claims');

  const { aud, jti, sub, client_id: clientId } = payload as Record<string, unknown>;
  const act = (payload as { act?: { sub?: unknown } }).act;
  const actor = act && typeof act.sub === 'string' ? act.sub : null;
  if (typeof aud !== 'string' || typeof jti !== 'string' || typeof clientId !== 'string') {
    return inactive('claim shape');
  }
  const log = { caller: callerId, resource: aud, jti };

  try {
    const resource = (await getExchangeResources()).find((r) => r.resource === aud);
    if (!resource) return inactive('resource not registered', log);
    if (!resource.introspectors.includes(callerId)) return inactive('not an introspector', log);
    if (!resource.apps.includes(clientId)) return inactive('app no longer listed', log);
    if (actor !== null && !resource.relays.includes(actor)) {
      return inactive('relay no longer listed', log);
    }

    const record = await readExchangeRecord(jti);
    if (!record) return inactive('no exchange record', log);
    if (
      record.resource !== aud ||
      record.clientId !== clientId ||
      record.actor !== actor ||
      String(record.userId) !== sub
    ) {
      return inactive('record does not match token', log);
    }

    const now = new Date();
    const subject = await findSubjectTokenById(record.subjectKeyId, now);
    if (!subject || subject.userId !== record.userId || subject.clientId !== clientId) {
      return inactive('subject token gone', log);
    }

    const app = await findExchangeClient(clientId);
    if (!app || app.accessMode === 'disabled') return inactive('app disabled', log);
    if (actor !== null) {
      const relay = await findExchangeClient(actor);
      if (!relay || relay.accessMode === 'disabled') return inactive('relay disabled', log);
    }

    const scopeBits = record.scopeBits & exchangeScopeCeiling(subject.tokenScope, resource, app);
    if (scopeBits === 0) return inactive('scope now empty', log);

    if (await userRefusal(record.userId, scopeBits, app)) return inactive('user refused', log);

    return {
      kind: 'active',
      body: {
        active: true,
        token_type: 'access_token',
        iss: payload.iss,
        sub,
        aud,
        client_id: clientId,
        ...(actor !== null ? { act: { sub: actor } } : {}),
        scope: scopeNames(scopeBits),
        exp: payload.exp,
        iat: payload.iat,
        jti,
      },
    };
  } catch (err) {
    void logToAxiom({
      type: 'error',
      name: 'introspect-jwt-indeterminate',
      message: String(err),
      ...log,
    }).catch(() => undefined);
    return { kind: 'indeterminate' };
  }
}
