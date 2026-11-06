import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAxiomLogger } from '../client';
import {
  isCredentialField,
  redactCredentials,
  redactCredentialsInString,
} from '../redact-credentials';

const FAKE_KEY = 'fakekey0123456789abcdef0123456789';

describe('redactCredentialsInString', () => {
  it.each([
    [`/api/download/models/1?token=${FAKE_KEY}`, '/api/download/models/1?token=[redacted]'],
    [
      `https://x.test/a?page=2&apiKey=${FAKE_KEY}&limit=10`,
      'https://x.test/a?page=2&apiKey=[redacted]&limit=10',
    ],
    [`https://x.test/a?api_key=${FAKE_KEY}`, 'https://x.test/a?api_key=[redacted]'],
    [`https://b.test/o?X-Amz-Signature=${FAKE_KEY}`, 'https://b.test/o?X-Amz-Signature=[redacted]'],
    [`/cb#access_token=${FAKE_KEY}&state=s`, '/cb#access_token=[redacted]&state=s'],
    [
      `fetch failed: GET https://x.test/a?token=${FAKE_KEY} 500`,
      'fetch failed: GET https://x.test/a?token=[redacted] 500',
    ],
    [`token=${FAKE_KEY}&page=2`, 'token=[redacted]&page=2'],
    [`/oauth/cb?code=${FAKE_KEY}&state=s`, '/oauth/cb?code=[redacted]&state=s'],
    [`https://cdn.test/f?sig=${FAKE_KEY}&w=450`, 'https://cdn.test/f?sig=[redacted]&w=450'],
    [`Authorization: Bearer ${FAKE_KEY}`, 'Authorization: Bearer [redacted]'],
  ])('blanks the credential in %s', (input, expected) => {
    expect(redactCredentialsInString(input)).toBe(expected);
  });

  it.each([
    '/api/v1/images?page=2&limit=10',
    '/api/x?tokens=5',
    '/api/x?tokenizer=clip&cursor=abc',
    '/api/x?keyword=cat',
    'the bearer of bad news',
    'see token=abc in prose',
  ])('leaves %s intact', (input) => {
    expect(redactCredentialsInString(input)).toBe(input);
  });
});

describe('redactCredentials', () => {
  it('blanks credential fields and scrubs nested strings, keeping near-miss fields', () => {
    const out = redactCredentials({
      headers: { authorization: `Bearer ${FAKE_KEY}`, 'x-api-key': FAKE_KEY, host: 'civitai.com' },
      url: `/api/v1/models?token=${FAKE_KEY}&page=2`,
      promptTokens: 120,
      tokenizer: 'clip',
      code: 'NOT_FOUND',
      list: [`?key=${FAKE_KEY}`],
    });
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(out).toMatchObject({
      headers: { host: 'civitai.com' },
      url: '/api/v1/models?token=[redacted]&page=2',
      promptTokens: 120,
      tokenizer: 'clip',
      code: 'NOT_FOUND',
    });
  });

  it('blanks credential fields whatever their shape, and custom x- credential headers', () => {
    const out = redactCredentials({
      headers: {
        'set-cookie': [`sid=${FAKE_KEY}`],
        'x-service-token': FAKE_KEY,
        'x-request-signature': FAKE_KEY,
        'x-request-id': 'req-1',
      },
      link: new URL(`https://x.test/a?token=${FAKE_KEY}`),
    });
    expect(JSON.stringify(out)).not.toContain(FAKE_KEY);
    expect(out.headers['x-request-id']).toBe('req-1');
    expect(out.link).toBe('https://x.test/a?token=[redacted]');
  });

  it.each([
    'authToken',
    'sessionToken',
    'csrf_token',
    'privateKey',
    'webhookSecret',
    'newPassword',
    'passwordHash',
    'x-internal-token',
    'x-request-signature',
    'authorizationHeader',
    'cookieHeader',
    'accessTokens',
    'apiKeys',
  ])('treats %s as a credential field', (name) => {
    expect(isCredentialField(name)).toBe(true);
  });

  it.each([
    'tokens',
    'tokenizer',
    'promptTokens',
    'maxTokens',
    'keyword',
    'code',
    'x-request-id',
    'x-session-reauth',
    'x-cache-key',
  ])('keeps %s', (name) => {
    expect(isCredentialField(name)).toBe(false);
  });

  it('does not mutate its input, arrays included', () => {
    const input = { token: FAKE_KEY, list: [`?token=${FAKE_KEY}`] };
    const out = redactCredentials(input);
    expect(input.token).toBe(FAKE_KEY);
    expect(input.list[0]).toContain(FAKE_KEY);
    expect(out.list[0]).toBe('?token=[redacted]');
  });

  it('keeps boolean flags on credential-named fields', () => {
    expect(redactCredentials({ hasPassword: true, password: FAKE_KEY })).toEqual({
      hasPassword: true,
      password: '[redacted]',
    });
  });

  it('returns clean subtrees by reference', () => {
    const clean = { a: { b: [1, 'x'] } };
    expect(redactCredentials(clean)).toBe(clean);
    const mixed = { clean: { page: 2 }, url: `?token=${FAKE_KEY}` };
    expect(redactCredentials(mixed).clean).toBe(mixed.clean);
  });
});

describe('logToAxiom', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes no credential to the stderr line or the OTel log bridge', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((l: unknown) => void lines.push(String(l)));
    const emitLog = vi.fn();
    const { logToAxiom } = createAxiomLogger(
      { isProd: true, podName: 'pod-test', datastream: 'civitai-errors' },
      { emitLog }
    );

    await logToAxiom({
      name: 'request',
      url: `/api/v1/models?token=${FAKE_KEY}`,
      headers: { authorization: `Bearer ${FAKE_KEY}` },
    });

    expect(lines.join('\n')).toContain('/api/v1/models?token=[redacted]');
    expect(lines.join('\n')).not.toContain(FAKE_KEY);
    expect(JSON.stringify(emitLog.mock.calls)).not.toContain(FAKE_KEY);
  });
});
