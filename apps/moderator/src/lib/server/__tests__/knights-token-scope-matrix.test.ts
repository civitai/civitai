import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authenticateWebhookToken } from '$lib/server/webhook-endpoint';

const KNIGHTS = 'knights-tag-review-token';
const INBOUND = 'inbound-only-token';
const saved = { ...process.env };
const ev = (path: string, token: string, how: 'query' | 'header' = 'query') => {
  const url = new URL(`https://moderator.civitai.com${path}`);
  if (how === 'query') url.searchParams.set('token', token);
  const headers = how === 'header' ? { authorization: `Bearer ${token}` } : undefined;
  return { url, request: new Request(url, { method: 'POST', headers }) };
};
const status = (r: ReturnType<typeof authenticateWebhookToken>) =>
  r.kind === 'refused' ? r.response.status : r.kind;

beforeEach(() => {
  process.env.MOD_INBOUND_TOKEN = INBOUND;
  process.env.KNIGHTS_TAG_REVIEW_TOKEN = KNIGHTS;
});
afterEach(() => {
  process.env.MOD_INBOUND_TOKEN = saved.MOD_INBOUND_TOKEN;
  process.env.KNIGHTS_TAG_REVIEW_TOKEN = saved.KNIGHTS_TAG_REVIEW_TOKEN;
  if (saved.MOD_INBOUND_TOKEN === undefined) delete process.env.MOD_INBOUND_TOKEN;
  if (saved.KNIGHTS_TAG_REVIEW_TOKEN === undefined) delete process.env.KNIGHTS_TAG_REVIEW_TOKEN;
});

describe('KNIGHTS_TAG_REVIEW_TOKEN scope', () => {
  it.each([
    '/api/mod/image-tag-moderate/',
    '/API/mod/image-tag-moderate',
    '/api/mod/Image-Tag-Moderate',
    '/api/mod//image-tag-moderate',
    '/api//mod/image-tag-moderate',
    '/api/mod/%69mage-tag-moderate',
    '/api/mod/image-tag-moderate%2F',
    '/api/mod/image-tag-moderate;x',
    '/api/mod/../mod/image-moderate',
    '/api/mod/image-tag-moderat',
    '/api/mod/image-moderate',
    '/api/user-mod-activity/1',
    '/api/mod',
  ])('refused (401) on %s, query and header', (path) => {
    expect(status(authenticateWebhookToken(ev(path, KNIGHTS)))).toBe(401);
    expect(status(authenticateWebhookToken(ev(path, KNIGHTS, 'header')))).toBe(401);
  });
  it('accepted on the exact path (query string tolerated)', () => {
    expect(status(authenticateWebhookToken(ev('/api/mod/image-tag-moderate?x=1', KNIGHTS)))).toBe(
      'authenticated'
    );
  });
  it('a dot-segment path that normalises to the scope is accepted only because it IS the scope', () => {
    expect(new URL('https://x/api/mod/foo/../image-tag-moderate').pathname).toBe(
      '/api/mod/image-tag-moderate'
    );
  });
  it('unset knights token: only MOD works on the scoped path', () => {
    delete process.env.KNIGHTS_TAG_REVIEW_TOKEN;
    expect(status(authenticateWebhookToken(ev('/api/mod/image-tag-moderate', KNIGHTS)))).toBe(401);
    expect(status(authenticateWebhookToken(ev('/api/mod/image-tag-moderate', INBOUND)))).toBe(
      'authenticated'
    );
  });
  it('knights token set, MOD unset: other routes fail closed 503, scoped path works', () => {
    delete process.env.MOD_INBOUND_TOKEN;
    expect(status(authenticateWebhookToken(ev('/api/mod/abuse-report', KNIGHTS)))).toBe(503);
    expect(status(authenticateWebhookToken(ev('/api/mod/image-tag-moderate', KNIGHTS)))).toBe(
      'authenticated'
    );
  });
  // The order follows main's rule for scoped credentials: a shared value resolves to the narrower class (last-match-wins),
  // so on the scoped path it attributes to the Knights token, and elsewhere only MOD_INBOUND_TOKEN can match it.
  it('same value in both: the scoped path attributes to the Knights token, every other path to MOD', () => {
    process.env.KNIGHTS_TAG_REVIEW_TOKEN = INBOUND;
    expect(authenticateWebhookToken(ev('/api/mod/image-tag-moderate', INBOUND))).toEqual({
      kind: 'authenticated',
      credential: 'KNIGHTS_TAG_REVIEW_TOKEN',
    });
    expect(authenticateWebhookToken(ev('/api/mod/image-moderate', INBOUND))).toEqual({
      kind: 'authenticated',
      credential: 'MOD_INBOUND_TOKEN',
    });
  });
});
