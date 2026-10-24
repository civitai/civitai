import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { env } from '$env/dynamic/private';
import { DEVICE_ID_PATTERN } from './constants';

// Salad IMDS JWT verification for the worker token-exchange grant. On only when WORKER_SALAD_JWT_ENABLED
// is "true" and the JWKS URL, issuer, audience and algorithms are all configured.

export type SaladIdentity = { machineId: string; containerGroupId: string };

export class SaladTokenError extends Error {}

// A token problem is the caller's; anything else (the JWKS fetch failing, say) is ours.
const TOKEN_ERRORS = [
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWTInvalid,
  errors.JWTClaimValidationFailed,
  errors.JWTExpired,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
];

// 10 minutes, plus 60 s for clock skew between Salad and us.
const MAX_TOKEN_LIFETIME_SECONDS = 600 + 60;

type SaladConfig = { jwksUrl: string; issuer: string; audience: string; algorithms: string[] };

function saladConfig(): SaladConfig | null {
  const algorithms = (env.WORKER_SALAD_JWT_ALGORITHMS ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const jwksUrl = env.WORKER_SALAD_JWKS_URL;
  const issuer = env.WORKER_SALAD_JWT_ISSUER;
  const audience = env.WORKER_SALAD_JWT_AUDIENCE;
  const enabled = env.WORKER_SALAD_JWT_ENABLED === 'true';
  if (!enabled || !jwksUrl || !issuer || !audience || algorithms.length === 0) return null;
  return { jwksUrl, issuer, audience, algorithms };
}

export function saladJwtEnabled(): boolean {
  return saladConfig() !== null;
}

const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(url: string) {
  let jwks = jwksByUrl.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksByUrl.set(url, jwks);
  }
  return jwks;
}

/** Verify a Salad IMDS JWT and read the machine and container group it was issued to. */
export async function verifySaladJwt(token: string): Promise<SaladIdentity> {
  const config = saladConfig();
  if (!config) throw new Error('Salad JWT verification is not configured');
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, jwksFor(config.jwksUrl), {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: config.algorithms,
      requiredClaims: ['exp'],
    }));
  } catch (err) {
    if (TOKEN_ERRORS.some((E) => err instanceof E)) {
      throw new SaladTokenError((err as Error).message);
    }
    throw err;
  }
  // Not jose's maxTokenAge: that needs an `iat` claim and does not bound `exp`.
  if ((payload.exp as number) - Math.floor(Date.now() / 1000) > MAX_TOKEN_LIFETIME_SECONDS) {
    throw new SaladTokenError('token expires too far in the future');
  }
  const machineId = payload.salad_machine_id;
  const containerGroupId = payload.salad_container_group_id;
  if (typeof machineId !== 'string' || typeof containerGroupId !== 'string') {
    throw new SaladTokenError('token is missing Salad claims');
  }
  if (!DEVICE_ID_PATTERN.test(machineId)) throw new SaladTokenError('invalid salad_machine_id');
  return { machineId, containerGroupId };
}
