import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIAL_PARAM_NAMES } from '@civitai/axiom/redact-credentials';

// `withAxiom` attaches the request URL as `request.path` to every `req.log` event it ships to
// Axiom. Webhook and job callers authenticate with `?token=`, so that path is where a credential
// would land. The redaction lives in patches/@civitai__next-axiom@0.17.0.patch.

const FAKE_TOKEN = 'faketoken0123456789abcdef01234567';

async function loadWithAxiom() {
  vi.resetModules();
  vi.stubEnv('AXIOM_TOKEN', 'ingest-test');
  vi.stubEnv('AXIOM_DATASET', 'test-dataset');
  vi.stubEnv('AXIOM_URL', 'https://axiom.invalid');
  const sent: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(String(init.body));
      return new Response('{}');
    })
  );
  const { withAxiom } = await import('@civitai/next-axiom');
  return { withAxiom, sent };
}

function fakeRes() {
  const res: Record<string, unknown> = { statusCode: 200 };
  res.status = () => res;
  res.json = () => res;
  res.send = () => res;
  res.end = () => res;
  res.setHeader = () => res;
  return res;
}

describe('next-axiom request.path', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('ships a webhook request with ?token= to Axiom without the token', async () => {
    const { withAxiom, sent } = await loadWithAxiom();
    const handler = withAxiom(async (req, res) => {
      req.log.info('job run');
      res.status(200).json({ ok: true });
    });

    await handler(
      {
        url: `/api/webhooks/run-jobs/some-job?token=${FAKE_TOKEN}&run=1`,
        method: 'GET',
        headers: { host: 'civitai.com' },
        query: {},
      } as never,
      fakeRes() as never
    );

    const shipped = sent.join('\n');
    expect(shipped).toContain('/api/webhooks/run-jobs/some-job?token=[redacted]&run=1');
    expect(shipped).not.toContain(FAKE_TOKEN);
  });

  it.each([
    [`/api/x?token=${FAKE_TOKEN}&page=2`, '/api/x?token=[redacted]&page=2'],
    [`/api/x?apiKey=${FAKE_TOKEN}`, '/api/x?apiKey=[redacted]'],
    [`/api/x?api_key=${FAKE_TOKEN}`, '/api/x?api_key=[redacted]'],
    [`/api/x?X-Amz-Signature=${FAKE_TOKEN}`, '/api/x?X-Amz-Signature=[redacted]'],
    [`/api/x?code=${FAKE_TOKEN}&state=s`, '/api/x?code=[redacted]&state=s'],
    ['/api/v1/images?page=2&limit=10', '/api/v1/images?page=2&limit=10'],
    ['/api/x?tokens=5&tokenizer=clip&keyword=cat', '/api/x?tokens=5&tokenizer=clip&keyword=cat'],
  ])('redacts the request path %s', async (input, expected) => {
    const generic = (await import('@civitai/next-axiom/dist/platform/generic')) as unknown as {
      redactRequestPath: (url: string) => string;
    };
    expect(generic.redactRequestPath(input)).toBe(expected);
  });

  it('redacts the same parameter names as @civitai/axiom', async () => {
    // The patch adds this export; the package's own .d.ts doesn't declare it.
    const generic = (await import('@civitai/next-axiom/dist/platform/generic')) as unknown as {
      CREDENTIAL_PARAM_NAMES: string[];
    };
    expect([...generic.CREDENTIAL_PARAM_NAMES].sort()).toEqual([...CREDENTIAL_PARAM_NAMES].sort());
  });
});
