import { randomBytes } from 'crypto';
import type { JWTPayload } from 'jose';
import { importJWK, SignJWT } from 'jose';
import { env } from '~/env/server';

const BASE_URL = 'api.developer.coinbase.com';
async function getJwt({ method, path }: { method: string; path: string }) {
  try {
    // Decode the base64 key (expecting 64 bytes: 32 for seed + 32 for public key)
    const decoded = Buffer.from(env.CDP_API_KEY_SECRET!, 'base64');
    if (decoded.length !== 64) {
      throw new Error('Invalid Ed25519 key length');
    }

    const seed = decoded.subarray(0, 32);
    const publicKey = decoded.subarray(32);

    // Create JWK from the key components
    const jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      d: seed.toString('base64url'),
      x: publicKey.toString('base64url'),
    };

    // Import the key for signing
    const key = await importJWK(jwk, 'EdDSA');

    // Prepare the JWT payload
    const claims: JWTPayload = {
      sub: env.CDP_API_KEY_ID!,
      iss: 'cdp',
      aud: ['cdp_service'],
      uris: [`${method} ${BASE_URL}${path}`],
    };

    // Sign and return the JWT
    const now = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(16).toString('hex');
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: 'EdDSA', kid: env.CDP_API_KEY_ID!, typ: 'JWT', nonce })
      .setIssuedAt(Math.floor(now))
      .setNotBefore(Math.floor(now))
      .setExpirationTime(Math.floor(now + 120))
      .sign(key);
  } catch (error) {
    throw new Error(`Failed to generate Ed25519 JWT: ${(error as Error).message}`);
  }
}

export async function fetchCoinbase({
  method,
  path,
  body,
}: {
  method: string;
  path: string;
  body?: object;
}) {
  const response = await fetch(`https://${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await getJwt({ method, path })}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Coinbase API: ${response.statusText}`);
  }

  return response.json();
}
