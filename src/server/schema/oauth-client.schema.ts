import { TokenScope } from '~/shared/constants/token-scope.constants';
import * as z from 'zod';

export const getOauthClientByIdSchema = z.object({ id: z.string() });
export type GetOauthClientByIdInput = z.infer<typeof getOauthClientByIdSchema>;

// Origins are exact-matched against the request `Origin` header for public
// clients, so they must be a scheme + host (+ optional port) with no path,
// query, fragment, or trailing slash — exactly the shape browsers send.
const originSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
        // Reject anything with a path/search/hash so the registered value
        // matches `req.headers.origin` byte-for-byte.
        return value === parsed.origin;
      } catch {
        return false;
      }
    },
    { message: 'Origin must be scheme://host[:port] with no path, query, or fragment' }
  );

export const createOauthClientSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(500).default(''),
  redirectUris: z.array(z.string().url()).min(1),
  allowedOrigins: z.array(originSchema).default([]),
  isConfidential: z.boolean().default(true),
  allowedScopes: z.number().int().min(0).max(TokenScope.Full).default(TokenScope.Full),
});
export type CreateOauthClientInput = z.infer<typeof createOauthClientSchema>;

export const updateOauthClientSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(500).optional(),
  redirectUris: z.array(z.string().url()).min(1).optional(),
  allowedOrigins: z.array(originSchema).optional(),
  allowedScopes: z.number().int().min(0).max(TokenScope.Full).optional(),
});
export type UpdateOauthClientInput = z.infer<typeof updateOauthClientSchema>;

/**
 * Default `allowedOrigins` derived from a list of redirect URIs — the origin
 * part of each URI, de-duplicated, preserving input order. Used as a fallback
 * at registration time and as the backfill for the schema migration so we
 * never break a currently-registered client on rollout.
 */
export function deriveAllowedOriginsFromRedirectUris(redirectUris: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const uri of redirectUris) {
    try {
      const parsed = new URL(uri);
      // originSchema only permits http/https. Filter here so the derive helper
      // never produces an entry the schema would reject.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      const origin = parsed.origin;
      if (origin === 'null') continue;
      if (seen.has(origin)) continue;
      seen.add(origin);
      result.push(origin);
    } catch {
      // Ignore malformed URIs — they would have failed the redirectUris schema
      // first, but stay defensive in case this is called on existing rows.
    }
  }
  return result;
}

export const deleteOauthClientSchema = z.object({ id: z.string() });
export type DeleteOauthClientInput = z.infer<typeof deleteOauthClientSchema>;

export const rotateOauthClientSecretSchema = z.object({ id: z.string() });
export type RotateOauthClientSecretInput = z.infer<typeof rotateOauthClientSecretSchema>;
