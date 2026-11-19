import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The closed-beta gate, for a signed-in user outside the beta: the training routes the main app's
// embed forwards here are open to whoever that app lets use the embed, and nothing else is.
const { guardCheck, betaAllows } = vi.hoisted(() => ({
  guardCheck: vi.fn(async (..._args: unknown[]) => ({
    status: 'ok',
    user: { id: 7 },
    setCookies: [] as string[],
  })),
  betaAllows: vi.fn(async () => false),
}));
vi.mock('$app/environment', () => ({ dev: false }));
vi.mock('$lib/server/auth', () => ({ guard: { check: guardCheck } }));
vi.mock('$lib/server/flipt', () => ({ isTrainingStudioAllowed: betaAllows }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: () => undefined }));

const { handle } = await import('../hooks.server');

async function run(path: string) {
  const url = new URL(`https://training.civitai.com${path}`);
  const resolve = vi.fn(async () => new Response(null, { status: 204 }));
  const response = await (handle as unknown as (arg: unknown) => Promise<Response>)({
    event: {
      url,
      request: new Request(url, { method: 'POST', headers: { cookie: 'civ-token=s' } }),
      locals: {},
      route: { id: null },
    },
    resolve,
  });
  return { response, resolve };
}

const mainApp = vi.fn();
beforeEach(() => {
  betaAllows.mockReset().mockResolvedValue(false);
  mainApp.mockReset().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal('fetch', mainApp);
});
afterEach(() => vi.unstubAllGlobals());

describe('closed beta, for a request the embed forwarded', () => {
  it.each([
    '/api/train',
    '/api/continue-training',
    '/api/dataset-rating',
    '/api/edit-image',
    '/api/suggest-instruction',
    '/api/epoch-archive',
  ])(
    '%s is served when the main app allows the embed, asked with the same session',
    async (path) => {
      const { response, resolve } = await run(path);
      expect(resolve).toHaveBeenCalled();
      expect(response.status).toBe(204);
      const [url, init] = mainApp.mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(/\/api\/training-studio\/access$/);
      expect((init.headers as Record<string, string>).cookie).toBe('civ-token=s');
    }
  );

  it.each([
    ['refuses', () => Response.json({ error: 'no' }, { status: 403 })],
    ['answers without ok', () => Response.json({})],
    ['cannot be reached', () => Promise.reject(new Error('down'))],
  ])('is refused when the main app %s', async (_label, answer) => {
    mainApp.mockImplementationOnce(answer);
    const { response, resolve } = await run('/api/train');
    expect(resolve).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
  });

  // The edit and suggestion polls ([id]) stay browser calls: only the exact submit paths open.
  it.each(['/api/rename', '/api/edit-image/wf-1', '/api/suggest-instruction/wf-1'])(
    'keeps %s closed, without asking the main app',
    async (path) => {
      const { response, resolve } = await run(path);
      expect(resolve).not.toHaveBeenCalled();
      expect(response.status).toBe(403);
      expect(mainApp).not.toHaveBeenCalled();
    }
  );

  it('serves a beta user without asking the main app', async () => {
    betaAllows.mockResolvedValueOnce(true);
    const { resolve } = await run('/api/train');
    expect(resolve).toHaveBeenCalled();
    expect(mainApp).not.toHaveBeenCalled();
  });
});
