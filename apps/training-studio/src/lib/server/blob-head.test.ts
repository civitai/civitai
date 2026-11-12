import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@civitai/orchestration-client', () => ({ createCivitaiClient: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: { ORCHESTRATOR_ENDPOINT: 'https://orch.test/' } }));

const { blobHead } = await import('./orchestrator');

afterEach(() => vi.unstubAllGlobals());

describe('blobHead', () => {
  it('sends a plain HEAD with the caller token and hands back the answer untouched', async () => {
    const answer = new Response(null, {
      status: 503,
      headers: { 'retry-after': '5', 'x-scan-status': 'Pending' },
    });
    const fetch = vi.fn(async () => answer);
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;

    const res = await blobHead('tok')!('urn:air:other:other:orchestrator:blob@abc.png', signal);

    expect(res.headers.get('x-scan-status')).toBe('Pending');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://orch.test/v2/consumer/blobs/abc.png');
    expect(init).toMatchObject({ method: 'HEAD', signal, redirect: 'manual' });
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });
});
