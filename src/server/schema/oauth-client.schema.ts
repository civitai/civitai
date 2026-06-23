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

/** Hostnames treated as loopback for redirect-URI port flexibility (RFC 8252 §7.3). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Does `provided` match one of the client's registered redirect URIs?
 *
 * Exact match for everything, PLUS RFC 8252 §7.3 port flexibility for loopback
 * redirects: a registered `http://localhost:18188/civitai/callback` also matches
 * `http://localhost:<any-port>/civitai/callback`. Native/desktop apps (e.g. the
 * ComfyUI node pack) can't pin a fixed loopback port — the OS may reserve it
 * (Windows excluded ranges) — so they bind a free port at runtime. Loopback
 * redirects target the user's own machine, so the port is not a security
 * boundary; non-loopback (https) URIs still require an exact match.
 */
export function redirectUriMatches(registeredUris: string[], provided: string): boolean {
  if (registeredUris.includes(provided)) return true;
  let providedUrl: URL;
  try {
    providedUrl = new URL(provided);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(providedUrl.hostname)) return false;
  return registeredUris.some((uri) => {
    try {
      const registered = new URL(uri);
      return (
        LOOPBACK_HOSTS.has(registered.hostname) &&
        registered.protocol === providedUrl.protocol &&
        registered.pathname === providedUrl.pathname
      );
    } catch {
      return false;
    }
  });
}

export const deleteOauthClientSchema = z.object({ id: z.string() });
export type DeleteOauthClientInput = z.infer<typeof deleteOauthClientSchema>;

export const rotateOauthClientSecretSchema = z.object({ id: z.string() });
export type RotateOauthClientSecretInput = z.infer<typeof rotateOauthClientSecretSchema>;
