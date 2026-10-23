import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { env } from '$env/dynamic/private';

// Salad IMDS JWT verification for the worker token-exchange grant. Off unless WORKER_SALAD_JWT_ENABLED is
// "true"; the JWKS URL, and optionally the issuer and audience, come from config.

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

export function saladJwtEnabled(): boolean {
  return env.WORKER_SALAD_JWT_ENABLED === 'true' && !!env.WORKER_SALAD_JWKS_URL;
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
  const url = env.WORKER_SALAD_JWKS_URL;
  if (!url) throw new SaladTokenError('Salad JWKS URL is not configured');
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, jwksFor(url), {
      issuer: env.WORKER_SALAD_JWT_ISSUER || undefined,
      audience: env.WORKER_SALAD_JWT_AUDIENCE || undefined,
      requiredClaims: ['exp'],
    }));
  } catch (err) {
    if (TOKEN_ERRORS.some((E) => err instanceof E)) {
      throw new SaladTokenError((err as Error).message);
    }
    throw err;
  }
  const machineId = payload.salad_machine_id;
  const containerGroupId = payload.salad_container_group_id;
  if (typeof machineId !== 'string' || !machineId || typeof containerGroupId !== 'string') {
    throw new SaladTokenError('token is missing Salad claims');
  }
  return { machineId, containerGroupId };
}
