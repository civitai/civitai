import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The edit prompt is checked here, by the main app, before anything is submitted: the embed sends its
// edits to this route and no longer checks the prompt itself.
const submitEditImage = vi.fn(async (..._args: unknown[]) => 'wf-edit');
// Empty: the client's dist imports a directory, which Node's ESM loader refuses; the route needs none of it.
vi.mock('@civitai/orchestration-client', () => ({}));
vi.mock('$lib/server/token', () => ({ requireToken: async () => 'token' }));
vi.mock('$lib/server/orchestrator', () => ({ orchestratorClient: () => ({}) }));
vi.mock('$lib/server/flipt', () => ({
  allowedModelFlags: async (_u: unknown, keys: string[]) => keys,
}));
vi.mock('$lib/server/main-app', () => ({ mainAppSessionOrigin: () => 'https://civitai.example' }));
vi.mock('$lib/server/axiom', () => ({ logToAxiom: () => undefined }));
vi.mock('$lib/edit-helpers-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/edit-helpers-core')>()),
  submitEditImage: (...args: unknown[]) => submitEditImage(...args),
}));

const { POST } = await import('./+server');

const imageUrl = 'https://orchestration.example/v2/consumer/blobs/abc.png';
const post = (prompt: string) =>
  POST({
    locals: { user: { id: 1 } },
    request: new Request('http://x/api/edit-image', {
      method: 'POST',
      headers: { cookie: 'civ-token=s' },
      body: JSON.stringify({ imageUrl, prompt }),
    }),
  } as unknown as Parameters<typeof POST>[0]);

const mainApp = vi.fn();
beforeEach(() => {
  submitEditImage.mockClear();
  mainApp.mockReset();
  vi.stubGlobal('fetch', mainApp);
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/edit-image', () => {
  it('submits nothing the main app refuses, and says why', async () => {
    mainApp.mockResolvedValueOnce(Response.json({ message: 'Not allowed: x' }, { status: 400 }));
    await expect(post('make it x')).rejects.toMatchObject({
      status: 400,
      body: { message: 'Not allowed: x' },
    });
    const [url, init] = mainApp.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://civitai.example/api/training-studio/check-text');
    expect(JSON.parse(String(init.body))).toEqual({
      editPrompt: 'make it x',
      inputImages: [imageUrl],
    });
    expect(submitEditImage).not.toHaveBeenCalled();
  });

  it('submits what the main app passes', async () => {
    mainApp.mockResolvedValueOnce(Response.json({ ok: true }));
    const res = await post('make it red');
    expect(await res.json()).toEqual({ workflowId: 'wf-edit' });
    expect(submitEditImage).toHaveBeenCalledTimes(1);
  });
});
