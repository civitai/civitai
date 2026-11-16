import { beforeEach, describe, expect, it, vi } from 'vitest';

// The cores are covered in train-core.test.ts; here the edit core only hands back that it ran, so the
// element's own reading of the host hooks is what is under test.
const core = vi.hoisted(() => ({ submitEditImage: vi.fn() }));
vi.mock('$lib/edit-helpers-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/edit-helpers-core')>()),
  submitEditImage: core.submitEditImage,
}));
vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: () => ({ interceptors: { response: { use: () => undefined } } }),
}));

import { elementBackend, type StudioElementHost } from './backend';
import { AutoLabelRefusedError } from '$lib/autolabel-errors';
import { TrainingTextRefusedError } from '$lib/training-text';

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

const edit = { prompt: 'make it red', imageUrl: 'https://blob.example/a.png' } as Parameters<
  ReturnType<typeof elementBackend>['editImageSubmit']
>[0];

describe('elementBackend edit prompt check', () => {
  beforeEach(() => {
    core.submitEditImage.mockReset().mockResolvedValue('wf-edit');
  });

  it('submits nothing the host refuses, and says why', async () => {
    const hostCheck = vi.fn(async () => ({ ok: false as const, error: 'blocked: x' }));
    await expect(elementBackend(host(hostCheck)).editImageSubmit(edit)).rejects.toThrow(
      new TrainingTextRefusedError('blocked: x')
    );
    expect(hostCheck).toHaveBeenCalledWith({
      editPrompt: edit.prompt,
      inputImages: [edit.imageUrl],
    });
    expect(core.submitEditImage).not.toHaveBeenCalled();
  });

  it('submits what the host passes', async () => {
    await expect(
      elementBackend(host(async () => ({ ok: true }))).editImageSubmit(edit)
    ).resolves.toEqual({ workflowId: 'wf-edit' });
  });

  it('submits nothing when the host page offers no check, or the check could not run', async () => {
    await expect(elementBackend(host(undefined)).editImageSubmit(edit)).rejects.toThrow();
    const failure = new Error('check failed');
    await expect(
      elementBackend(host(async () => Promise.reject(failure))).editImageSubmit(edit)
    ).rejects.toBe(failure);
    expect(core.submitEditImage).not.toHaveBeenCalled();
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
    await expect(elementBackend({ ...host(), modelLive }).modelLive(77)).resolves.toBe(false);
    expect(modelLive).toHaveBeenCalledWith(77);
  });

  it('keeps the link on a host without the hook', async () => {
    await expect(elementBackend(host()).modelLive(77)).resolves.toBe(true);
  });
});

describe('elementBackend keep training', () => {
  it.each([true, false])("sends the Studio server the panel's confirm (%s)", async (ack) => {
    const studioServer = vi.fn(async () => Response.json({ workflowId: 'wf-next' }));
    await expect(
      elementBackend(host(undefined, studioServer)).continueRun('wf', 1, 2, ['blue'], ack)
    ).resolves.toBe('wf-next');
    const [path, init] = studioServer.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/continue-training');
    expect(JSON.parse(String(init.body))).toEqual({
      workflowId: 'wf',
      fromEpoch: 1,
      addEpochs: 2,
      currencies: ['blue'],
      matureAck: ack,
    });
  });

  it("turns the server's mature refusal into the confirm", async () => {
    const studioServer = async () =>
      Response.json({ message: 'm', matureCount: 3 }, { status: 409 });
    await expect(
      elementBackend(host(undefined, studioServer)).continueRun('wf', 1, 2, ['green'], false)
    ).rejects.toMatchObject({ matureCount: 3 });
  });

  it("shows the host's reason for a refusal it made before forwarding", async () => {
    const studioServer = async () =>
      Response.json({ error: 'Verify your email address to do this' }, { status: 403 });
    const backend = elementBackend(host(undefined, studioServer));
    await expect(backend.continueRun('wf', 1, 2, ['green'], false)).rejects.toThrow(
      'Verify your email address to do this'
    );
    await expect(backend.continueQuote('wf', 1, 2, ['green'])).rejects.toThrow(
      'Verify your email address to do this'
    );
  });

  it('prices and starts nothing on a host page without the Studio server', async () => {
    const backend = elementBackend(host(async () => ({ ok: true })));
    await expect(backend.continueQuote('wf', 1, 2, ['green'])).rejects.toThrow(/unavailable/);
    await expect(backend.continueRun('wf', 1, 2, ['green'], true)).rejects.toThrow(/unavailable/);
    expect(backend.datasetRating).toBeUndefined();
  });
});
