import { describe, expect, it, vi } from 'vitest';

vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: () => ({ interceptors: { response: { use: () => undefined } } }),
}));

import { elementBackend, type StudioElementHost } from './backend';
import { AutoLabelRefusedError } from '$lib/autolabel-errors';

function host(
  checkTrainingText?: StudioElementHost['checkTrainingText'],
  studioServer?: StudioElementHost['studioServer']
): StudioElementHost {
  return {
    getOrchestratorToken: async () => 'token',
    checkTrainingText,
    studioServer,
    config: { orchestratorEndpoint: 'https://orchestrator.example' },
    hrefFor: () => '/',
    navigate: async () => undefined,
  };
}

const edit = {
  prompt: 'make it red',
  imageUrl: 'https://blob.example/a.png',
  currencies: ['green'],
};
const suggest = {
  beforeUrl: 'https://blob.example/a.png',
  afterUrl: 'https://blob.example/b.png',
  currencies: ['green'],
};

// The paid calls never use the browser's orchestrator token: no token minted means nothing was sent
// to the orchestrator from here.
describe('elementBackend paid helpers go through the Studio server', () => {
  const paid = [
    {
      name: 'editImageSubmit',
      run: (b: ReturnType<typeof elementBackend>) => b.editImageSubmit(edit),
      reply: { workflowId: 'wf-edit' },
      path: '/api/edit-image',
      body: edit,
      result: { workflowId: 'wf-edit' },
    },
    {
      name: 'suggestSubmit',
      run: (b: ReturnType<typeof elementBackend>) => b.suggestSubmit(suggest),
      reply: { workflowId: 'wf-suggest' },
      path: '/api/suggest-instruction',
      body: suggest,
      result: { workflowId: 'wf-suggest' },
    },
    {
      name: 'epochArchive',
      run: (b: ReturnType<typeof elementBackend>) => b.epochArchive('wf 1', 'samples'),
      reply: [{ url: 'https://blob.example/a.zip', entryCount: 2 }],
      path: '/api/epoch-archive?id=wf+1&kind=samples',
      body: {},
      result: [{ url: 'https://blob.example/a.zip', entryCount: 2 }],
    },
  ];

  it.each(paid)('$name posts to $path and mints no orchestrator token', async (c) => {
    const studioServer = vi.fn(async () => Response.json(c.reply));
    const getOrchestratorToken = vi.fn(async () => 'token');
    const backend = elementBackend({ ...host(undefined, studioServer), getOrchestratorToken });
    await expect(c.run(backend)).resolves.toEqual(c.result);
    expect(studioServer).toHaveBeenCalledTimes(1);
    const [path, init] = studioServer.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe(c.path);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual(c.body);
    expect(getOrchestratorToken).not.toHaveBeenCalled();
  });

  it.each(paid)('$name refuses on a host without studioServer, sending nothing', async (c) => {
    const getOrchestratorToken = vi.fn(async () => 'token');
    const backend = elementBackend({ ...host(async () => ({ ok: true })), getOrchestratorToken });
    await expect(c.run(backend)).rejects.toThrow(/unavailable on this page/);
    expect(getOrchestratorToken).not.toHaveBeenCalled();
  });

  it("shows the server's reason for a refused edit prompt", async () => {
    const studioServer = async () =>
      Response.json({ message: 'That prompt is not allowed.' }, { status: 400 });
    await expect(
      elementBackend(host(undefined, studioServer)).editImageSubmit(edit)
    ).rejects.toThrow('That prompt is not allowed.');
  });
});

describe('elementBackend auto-label payer', () => {
  const items = [{ key: 'a.png', mediaUrl: 'https://blob.example/a.png' }];

  it('never submits with the user token when the host offers no system-paid path', async () => {
    const getOrchestratorToken = vi.fn(async () => 'user-token');
    const backend = elementBackend({ ...host(), getOrchestratorToken });
    await expect(backend.autoLabelSubmit(items, 'tag', 'image')).rejects.toBeInstanceOf(
      AutoLabelRefusedError
    );
    await expect(backend.autoLabelSubmit(items, 'tag', 'image')).rejects.toThrow(/unavailable/);
    expect(getOrchestratorToken).not.toHaveBeenCalled();
  });

  it("uses the host's auto-label when it offers one", async () => {
    const autoLabelSubmit = vi.fn(async () => ({ workflowId: 'wf-sys' }));
    const getOrchestratorToken = vi.fn(async () => 'user-token');
    const backend = elementBackend({ ...host(), getOrchestratorToken, autoLabelSubmit });
    await expect(backend.autoLabelSubmit(items, 'tag', 'image')).resolves.toEqual({
      workflowId: 'wf-sys',
    });
    expect(autoLabelSubmit).toHaveBeenCalledWith(items, 'tag', 'image');
    expect(getOrchestratorToken).not.toHaveBeenCalled();
  });
});

describe('elementBackend modelLive', () => {
  it("answers with the host's check", async () => {
    const modelLive = vi.fn(async () => false);
    await expect(elementBackend({ ...host(), modelLive }).modelLive(77, 770)).resolves.toBe(false);
    expect(modelLive).toHaveBeenCalledWith(77, 770);
  });

  it('keeps the link on a host without the hook', async () => {
    await expect(elementBackend(host()).modelLive(77)).resolves.toBe(true);
  });
});

describe('elementBackend keep training', () => {
  it('sends the Studio server the continuation', async () => {
    const studioServer = vi.fn(async () => Response.json({ workflowId: 'wf-next' }));
    await expect(
      elementBackend(host(undefined, studioServer)).continueRun('wf', 1, 2, ['blue'], 0)
    ).resolves.toBe('wf-next');
    const [path, init] = studioServer.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/continue-training');
    expect(JSON.parse(String(init.body))).toEqual({
      workflowId: 'wf',
      fromEpoch: 1,
      addEpochs: 2,
      currencies: ['blue'],
      matureCount: 0,
    });
  });

  it("turns the server's reprice refusal into the mature count", async () => {
    const studioServer = async () =>
      Response.json({ message: 'm', matureCount: 3 }, { status: 409 });
    await expect(
      elementBackend(host(undefined, studioServer)).continueRun('wf', 1, 2, ['green'], 0)
    ).rejects.toMatchObject({ matureCount: 3 });
  });

  it("shows the host's reason for a refusal it made before forwarding", async () => {
    const studioServer = async () =>
      Response.json({ error: 'Verify your email address to do this' }, { status: 403 });
    const backend = elementBackend(host(undefined, studioServer));
    await expect(backend.continueRun('wf', 1, 2, ['green'], 0)).rejects.toThrow(
      'Verify your email address to do this'
    );
    await expect(backend.continueQuote('wf', 1, 2, ['green'])).rejects.toThrow(
      'Verify your email address to do this'
    );
  });

  it('prices and starts nothing on a host page without the Studio server', async () => {
    const backend = elementBackend(host(async () => ({ ok: true })));
    await expect(backend.continueQuote('wf', 1, 2, ['green'])).rejects.toThrow(/unavailable/);
    await expect(backend.continueRun('wf', 1, 2, ['green'], 0)).rejects.toThrow(/unavailable/);
    expect(backend.datasetRating).toBeUndefined();
  });
});
