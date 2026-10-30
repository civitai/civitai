import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./axiom', () => ({ logToAxiom: vi.fn() }));

import { TrainingTextCheckError, TrainingTextRefusedError } from '$lib/training-text';
import { mainAppSessionOrigin } from './main-app';
import { mainAppTextCheck } from './text-check';

const input = { triggerWord: 'mystyle' };

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('mainAppTextCheck', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes only on an explicit ok, forwarding the cookie without following redirects', async () => {
    const fetch = answer(200, { ok: true });
    await expect(mainAppTextCheck('civ-token=x', 1)(input)).resolves.toBeUndefined();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://civitai.com/api/training-studio/check-text');
    expect(init).toMatchObject({ redirect: 'error', headers: { cookie: 'civ-token=x' } });
  });

  it('does not pass a 2xx without the verdict', async () => {
    answer(200, { something: 'else' });
    await expect(mainAppTextCheck('', 1)(input)).rejects.not.toBeInstanceOf(
      TrainingTextRefusedError
    );
  });

  it('turns a 400 into a refusal carrying the reason', async () => {
    answer(400, { message: 'blocked: x' });
    await expect(mainAppTextCheck('', 1)(input)).rejects.toThrow(
      new TrainingTextRefusedError('blocked: x')
    );
  });

  it.each([413, 429, 503, 404])('a %i is a failure to check, not a refusal', async (status) => {
    answer(status, { error: 'nope' });
    const error = await mainAppTextCheck('', 1)(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TrainingTextCheckError);
    expect(error).toMatchObject({ status, message: 'nope' });
  });
});

describe('mainAppTextCheck when the request fails', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('answers with a generic failure, not the underlying error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED internal-host:3000');
      })
    );
    const error = await mainAppTextCheck('', 1)(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TrainingTextCheckError);
    expect((error as Error).message).not.toContain('internal-host');
  });
});

describe('mainAppSessionOrigin', () => {
  it('accepts https, and http only for a local main app', () => {
    expect(mainAppSessionOrigin('https://civitai.com/')).toBe('https://civitai.com');
    expect(mainAppSessionOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(() => mainAppSessionOrigin('http://civitai.com')).toThrow(/https/);
  });
});
