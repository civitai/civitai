import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';

import { SignJWT } from 'jose';

/**
 * TEST-ONLY signing keys, generated fresh for each test process and never written anywhere. They
 * stand in for civitai's key pair: tests sign viewer tokens and run grants with the private half the
 * way civitai does, and the runner verifies them with the public half.
 *
 * The claim names and values below are spelled out, not imported from `../tokens`, so they pin the
 * wire contract civitai signs (`src/server/services/app-assistant/assistant-runner-tokens.ts`,
 * whose own test pins the same literals) rather than whatever the runner happens to expect.
 */
export interface TestKeys {
  publicPem: string;
  privateKey: KeyObject;
}

export function testKeys(): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
}

export interface SignOptions {
  aud: string;
  typ: string;
  sub: string;
  claims?: Record<string, unknown>;
  /** Seconds from now; negative for a token that already expired. */
  expiresIn?: number;
  issuer?: string;
}

export async function signTestToken(key: KeyObject, options: SignOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...options.claims })
    .setProtectedHeader({ alg: 'ES256', typ: options.typ })
    .setIssuer(options.issuer ?? 'civitai')
    .setAudience(options.aud)
    .setSubject(options.sub)
    .setJti(randomUUID())
    .setIssuedAt(now - 1)
    .setExpirationTime(now + (options.expiresIn ?? 300))
    .sign(key);
}

export const VIEWER = { aud: 'assistant-runner:viewer', typ: 'assistant-viewer+jwt' } as const;
export const GRANT = { aud: 'assistant-runner:run-grant', typ: 'assistant-run-grant+jwt' } as const;

export function signViewer(keys: TestKeys, userId: string, expiresIn = 300): Promise<string> {
  return signTestToken(keys.privateKey, { ...VIEWER, sub: userId, expiresIn });
}

export function signGrant(
  keys: TestKeys,
  grant: { userId: string; conversationId: string; idempotencyKey: string },
  expiresIn = 7800,
  /** More claims, as civitai adds them (`subagents: true`). */
  extra: Record<string, unknown> = {}
): Promise<string> {
  return signTestToken(keys.privateKey, {
    ...GRANT,
    sub: grant.userId,
    claims: { cid: grant.conversationId, key: grant.idempotencyKey, ...extra },
    expiresIn,
  });
}
