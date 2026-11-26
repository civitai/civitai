import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { oauthRateLimitRef, rateLimitedResponse } from '../rate-limit';

const SRC = fileURLToPath(new URL('../../../../', import.meta.url));
const BUILDER = 'lib/server/oauth/rate-limit.ts';
// The OAuth library needs a status on the error it throws; the token route maps it to the builder.
const STATUS_CONSTANT_ALLOWED = new Set([BUILDER, 'lib/server/oauth/worker-grant.ts']);

// Each way a 429 has been written in this app: a json/Response status, an error()/fail()/helper call,
// a refuse() status map entry, and the OAuth library's error code.
const BARE_429 = /status: 429|\(429,|, 429\)|fail\(429|error\(429|rate_limited: 429|code: 429/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === '__tests__' || entry.name === 'test' ? [] : sources(path);
    return /\.(ts|js)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

/** Every line that builds a 429 outside rateLimitedResponse, as `file:line: text`. */
function bare429s(files: { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) => {
    if (path === BUILDER) return [];
    return text.split('\n').flatMap((line, i) => {
      const at = `${path}:${i + 1}: ${line.trim()}`;
      // The login form answers in-page, not with a Response; it must still carry the retry time.
      if (/fail\(429/.test(line)) return /retryAfter/.test(line) ? [] : [at];
      if (BARE_429.test(line)) return [at];
      if (/RATE_LIMITED_STATUS/.test(line) && !STATUS_CONSTANT_ALLOWED.has(path)) return [at];
      return [];
    });
  });
}

describe('every auth 429 says when to retry', () => {
  it('is built by rateLimitedResponse, never by hand', () => {
    const files = sources(SRC).map((p) => ({
      path: relative(SRC, p).split('\\').join('/'),
      text: readFileSync(p, 'utf8'),
    }));
    expect(files.length).toBeGreaterThan(50);
    expect(bare429s(files)).toEqual([]);
  });

  it('flags each shape a bare 429 takes', () => {
    const shapes = [
      "return json({ error: 'rate_limited' }, { status: 429, headers });",
      "return bad('rate_limited', 'Too many', 429);",
      "return oauthError(429, 'rate_limited');",
      "error(429, 'Too many requests');",
      'return fail(429, { email, rateLimited: true });',
      '  rate_limited: 429,',
      "super('x', { code: 429, name: 'rate_limited' });",
      'return new Response(null, { status: RATE_LIMITED_STATUS });',
    ];
    const found = bare429s(shapes.map((text, i) => ({ path: `routes/f${i}.ts`, text })));
    expect(found).toHaveLength(shapes.length);
    expect(
      bare429s([
        {
          path: 'routes/ok.ts',
          text: 'return fail(429, { email, rateLimited: true, retryAfter });',
        },
      ])
    ).toEqual([]);
  });
});

describe('rateLimitedResponse', () => {
  it('answers a request that accepts HTML with a page, in minutes from 60 s', async () => {
    const request = new Request('https://auth.civitai.com/x', { headers: { accept: 'text/html' } });
    const res = rateLimitedResponse(90, undefined, 'Too many <attempts>', { request });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('90');
    expect(await res.text()).toContain('Too many &lt;attempts&gt;. Try again in 2 minutes.');
  });

  it('sets Retry-After and retry_after in whole seconds, never below 1, keeping the caller headers', async () => {
    const res = rateLimitedResponse(
      0.2,
      { 'Cache-Control': 'no-store' },
      'Too many token requests'
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      error: 'rate_limited',
      error_description: 'Too many token requests',
      retry_after: 1,
      rateLimit: { retryAfterSeconds: 1, retryAt: expect.any(String) },
    });
  });

  it('carries the house rateLimit meta: the retry instant, and the limit the caller names', async () => {
    const before = Date.now();
    const res = rateLimitedResponse(60, undefined, 'Too many token requests', {
      limit: oauthRateLimitRef('token-exchange'),
    });
    const body = (await res.json()) as { rateLimit: Record<string, unknown> };
    expect(body.rateLimit).toEqual({
      retryAfterSeconds: 60,
      retryAt: expect.any(String),
      id: 'oauth.token-exchange',
      kind: 'abuse',
    });
    const retryAt = Date.parse(body.rateLimit.retryAt as string);
    expect(retryAt).toBeGreaterThanOrEqual(before + 60_000 - 1000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 60_000 + 1000);
  });
});
