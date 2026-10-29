import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mainAppModelLive } from './model-status';

const mainApp = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubEnv('CIVITAI_URL', 'https://civitai.test');
  vi.stubGlobal('fetch', mainApp);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mainApp.mockReset();
});

describe('mainAppModelLive', () => {
  it('asks the main app as the user and returns its answer', async () => {
    mainApp.mockResolvedValue(Response.json({ live: false }));
    await expect(mainAppModelLive('session=abc')(77)).resolves.toBe(false);
    const [url, init] = mainApp.mock.calls[0]!;
    expect(url).toBe('https://civitai.test/api/training-studio/model-status?id=77');
    expect(new Headers(init.headers).get('cookie')).toBe('session=abc');
  });

  // Decision: no answer is not "deleted". The run page keeps the link on a rejection, so a failed
  // check must reject rather than resolve false.
  it.each([
    ['an error status', () => new Response('down', { status: 503 })],
    ['a body without an answer', () => Response.json({})],
  ])('rejects on %s', async (_label, answer) => {
    mainApp.mockResolvedValue(answer());
    await expect(mainAppModelLive('session=abc')(77)).rejects.toThrow();
  });
});
