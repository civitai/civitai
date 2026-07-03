import { describe, it, expect } from 'vitest';
import {
  REDACTED,
  REDACTED_EMAIL,
  REDACTED_TOKEN,
  deepRedact,
  isSensitiveParam,
  redactText,
  redactUrl,
} from '~/utils/faro/redact';

describe('isSensitiveParam', () => {
  it('matches sensitive names case-insensitively and as substrings', () => {
    for (const name of [
      'token',
      'CODE',
      'access_token',
      'id_token',
      'refresh_token',
      'apiKey',
      'X-Amz-Signature',
      'user_email',
      'sessionId',
      'client_secret',
      'otp',
      'verifyToken',
      'password',
    ]) {
      expect(isSensitiveParam(name)).toBe(true);
    }
  });

  it('leaves benign params alone', () => {
    for (const name of ['page', 'limit', 'sort', 'id', 'tab', 'q', 'cursor']) {
      expect(isSensitiveParam(name)).toBe(false);
    }
  });
});

describe('redactUrl', () => {
  it('redacts an OAuth authorization callback (code) but keeps state', () => {
    const out = redactUrl('https://civitai.com/api/auth/callback?code=abc123SECRET&state=xyz789');
    expect(out).not.toContain('abc123SECRET');
    expect(out).toContain(`code=${REDACTED}`);
    // non-sensitive param preserved
    expect(out).toContain('state=xyz789');
  });

  it('redacts a password-reset / verify token URL (token + email)', () => {
    const out = redactUrl('/reset-password?token=super-secret-token&email=user%40example.com&next=/models');
    expect(out).not.toContain('super-secret-token');
    expect(out).not.toContain('user@example.com');
    expect(out).not.toContain('user%40example.com');
    expect(out).toContain(`token=${REDACTED}`);
    expect(out).toContain(`email=${REDACTED}`);
    // relative URL stays relative and keeps the benign param
    expect(out.startsWith('/reset-password?')).toBe(true);
    expect(out).toContain('next=%2Fmodels');
  });

  it('redacts a signed S3-style download URL (signature) but keeps the path', () => {
    const signed =
      'https://cdn.civitai.com/model-files/123/model.safetensors' +
      '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeefcafef00d1234567890abcdef&X-Amz-Expires=3600';
    const out = redactUrl(signed);
    expect(out).not.toContain('deadbeefcafef00d1234567890abcdef');
    expect(out).toContain('X-Amz-Signature=' + REDACTED);
    // path + a benign param preserved
    expect(out).toContain('/model-files/123/model.safetensors');
    expect(out).toContain('X-Amz-Expires=3600');
  });

  it('redacts tokens carried in the URL fragment (OAuth implicit flow)', () => {
    const out = redactUrl('https://civitai.com/auth#access_token=xyzTOKEN123&token_type=bearer&state=ok');
    expect(out).not.toContain('xyzTOKEN123');
    expect(out).toContain('access_token=' + REDACTED);
    expect(out).toContain('state=ok');
  });

  it('leaves a clean URL unchanged (identical string, no reserialization)', () => {
    const clean = 'https://civitai.com/models/123?page=2&sort=newest';
    expect(redactUrl(clean)).toBe(clean);
  });

  it('leaves a clean relative URL unchanged', () => {
    const clean = '/models/123?page=2';
    expect(redactUrl(clean)).toBe(clean);
  });

  it('never throws on malformed input', () => {
    expect(() => redactUrl('not a url ??&&==')).not.toThrow();
    expect(redactUrl('')).toBe('');
  });
});

describe('redactText', () => {
  it('redacts an email embedded in an error message', () => {
    const out = redactText('Failed to send invite to alice.smith+promo@example.co.uk after 3 tries');
    expect(out).not.toContain('alice.smith+promo@example.co.uk');
    expect(out).toContain(REDACTED_EMAIL);
    // surrounding context preserved
    expect(out).toContain('Failed to send invite to');
    expect(out).toContain('after 3 tries');
  });

  it('redacts a JWT embedded in a stack/error string', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactText(`Auth error with bearer ${jwt} while calling /api/trpc`);
    expect(out).not.toContain(jwt);
    expect(out).toContain(REDACTED_TOKEN);
    expect(out).toContain('/api/trpc');
  });

  it('redacts sensitive query params inside a URL embedded in text', () => {
    const out = redactText('navigation to https://civitai.com/verify?code=SHORTCODE&ref=email failed');
    expect(out).not.toContain('SHORTCODE');
    expect(out).toContain('code=' + REDACTED);
    expect(out).toContain('ref=email');
  });

  it('leaves clean text unchanged', () => {
    const clean = 'TypeError: Cannot read properties of undefined (reading map) at Feed.render';
    expect(redactText(clean)).toBe(clean);
  });

  it('never throws on empty input', () => {
    expect(redactText('')).toBe('');
  });
});

describe('deepRedact', () => {
  it('scrubs strings recursively, using url-aware redaction for url-ish keys', () => {
    const payload = {
      message: 'login failed for bob@example.com',
      page: {
        url: 'https://civitai.com/callback?code=SECRETCODE&page=1',
        title: 'Callback',
      },
      attributes: {
        href: '/reset?token=abcdef',
        count: 3,
        nested: ['plain', 'reach me at eve@example.org'],
      },
    };
    const out = deepRedact(payload);

    expect(out.message).toContain(REDACTED_EMAIL);
    expect(out.message).not.toContain('bob@example.com');
    expect(out.page.url).toContain('code=' + REDACTED);
    expect(out.page.url).not.toContain('SECRETCODE');
    expect(out.page.url).toContain('page=1');
    expect(out.page.title).toBe('Callback');
    expect(out.attributes.href).toContain('token=' + REDACTED);
    expect(out.attributes.count).toBe(3);
    expect(out.attributes.nested[0]).toBe('plain');
    expect(out.attributes.nested[1]).toContain(REDACTED_EMAIL);
  });

  it('does not mutate the input object', () => {
    const payload = { message: 'contact carol@example.com' };
    const out = deepRedact(payload);
    expect(payload.message).toBe('contact carol@example.com');
    expect(out.message).not.toBe(payload.message);
  });

  it('handles primitives and nullish values without throwing', () => {
    expect(deepRedact(42)).toBe(42);
    expect(deepRedact(null)).toBe(null);
    expect(deepRedact(undefined)).toBe(undefined);
    expect(deepRedact(true)).toBe(true);
  });
});
