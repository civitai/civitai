import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAxiomLogger } from '../client';
import { redactCredentials, redactCredentialsInString } from '../redact-credentials';

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

  it('does not mutate its input', () => {
    const input = { token: FAKE_KEY };
    redactCredentials(input);
    expect(input.token).toBe(FAKE_KEY);
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
