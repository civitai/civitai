import { describe, it, expect } from 'vitest';
import {
  createOauthClientSchema,
  updateOauthClientSchema,
  deriveAllowedOriginsFromRedirectUris,
  redirectUriMatches,
} from '../oauth-client.schema';

describe('createOauthClientSchema', () => {
  const validBase = {
    name: 'My App',
    description: 'desc',
    redirectUris: ['https://example.com/cb'],
  };

  it('accepts valid scheme://host[:port] origins', () => {
    const result = createOauthClientSchema.safeParse({
      ...validBase,
      allowedOrigins: [
        'https://example.com',
        'http://localhost:5173',
        'https://app.example.com:8443',
      ],
    });
    expect(result.success).toBe(true);
  });

  it('defaults allowedOrigins to []', () => {
    const result = createOauthClientSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.allowedOrigins).toEqual([]);
  });

  it('rejects origins with a trailing path', () => {
    const result = createOauthClientSchema.safeParse({
      ...validBase,
      allowedOrigins: ['https://example.com/'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects origins with a path segment', () => {
    const result = createOauthClientSchema.safeParse({
      ...validBase,
      allowedOrigins: ['https://example.com/callback'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects origins with a query string', () => {
    const result = createOauthClientSchema.safeParse({
      ...validBase,
      allowedOrigins: ['https://example.com?foo=bar'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects origins with a fragment', () => {
    const result = createOauthClientSchema.safeParse({
      ...validBase,
      allowedOrigins: ['https://example.com#x'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-http(s) schemes', () => {
    const result = createOauthClientSchema.safeParse({
      ...validBase,
      allowedOrigins: ['ftp://example.com'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects plain non-URL strings', () => {
    const result = createOauthClientSchema.safeParse({
      ...validBase,
      allowedOrigins: ['example.com'],
    });
    expect(result.success).toBe(false);
  });
});

describe('updateOauthClientSchema', () => {
  it('treats allowedOrigins as optional', () => {
    const result = updateOauthClientSchema.safeParse({ id: 'abc' });
    expect(result.success).toBe(true);
  });

  it('validates allowedOrigins when provided', () => {
    const result = updateOauthClientSchema.safeParse({
      id: 'abc',
      allowedOrigins: ['https://example.com/oops'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty array (to clear the allowlist)', () => {
    const result = updateOauthClientSchema.safeParse({
      id: 'abc',
      allowedOrigins: [],
    });
    expect(result.success).toBe(true);
  });
});

describe('deriveAllowedOriginsFromRedirectUris', () => {
  it('returns unique origins preserving input order', () => {
    const origins = deriveAllowedOriginsFromRedirectUris([
      'https://example.com/cb',
      'https://example.com/cb2',
      'https://other.example.com/cb',
    ]);
    expect(origins).toEqual(['https://example.com', 'https://other.example.com']);
  });

  it('keeps the port when present', () => {
    const origins = deriveAllowedOriginsFromRedirectUris(['http://localhost:5173/auth/cb']);
    expect(origins).toEqual(['http://localhost:5173']);
  });

  it('skips malformed URIs', () => {
    const origins = deriveAllowedOriginsFromRedirectUris(['not a url', 'https://example.com/cb']);
    expect(origins).toEqual(['https://example.com']);
  });

  it('returns [] for an empty input', () => {
    expect(deriveAllowedOriginsFromRedirectUris([])).toEqual([]);
  });
});

describe('redirectUriMatches', () => {
  const registered = ['http://localhost:18188/civitai/callback', 'https://app.example.com/cb'];

  it('matches an exact registered URI', () => {
    expect(redirectUriMatches(registered, 'http://localhost:18188/civitai/callback')).toBe(true);
    expect(redirectUriMatches(registered, 'https://app.example.com/cb')).toBe(true);
  });

  it('allows any port for a loopback redirect (RFC 8252)', () => {
    expect(redirectUriMatches(registered, 'http://localhost:58264/civitai/callback')).toBe(true);
    expect(redirectUriMatches(registered, 'http://localhost:9999/civitai/callback')).toBe(true);
  });

  it('still requires the same loopback path and scheme', () => {
    expect(redirectUriMatches(registered, 'http://localhost:58264/other/path')).toBe(false);
    expect(redirectUriMatches(registered, 'https://localhost:58264/civitai/callback')).toBe(false);
  });

  it('does NOT give port flexibility to non-loopback hosts', () => {
    expect(redirectUriMatches(registered, 'https://app.example.com:8443/cb')).toBe(false);
    expect(redirectUriMatches(registered, 'https://evil.example.com/cb')).toBe(false);
  });

  it('rejects malformed or empty redirect URIs', () => {
    expect(redirectUriMatches(registered, 'not a url')).toBe(false);
    expect(redirectUriMatches(registered, '')).toBe(false);
  });
});
