import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';

/** Each orchestrator route that reads a client url checks it before it fetches, prices or submits. */

// 🔴 Do NOT mock `~/env/server` here — see `deprecated-rewards.gate.test.ts` for why importing
// `orchestrator.router` relies on the canonical env mock.

const h = vi.hoisted(() => ({
  assertInputs: vi.fn(),
  generateFromGraph: vi.fn(async () => ({})),
  whatIfFromGraph: vi.fn(async () => ({})),
  imageUpload: vi.fn(async () => ({})),
  submitPresetImageGen: vi.fn(async () => ({ workflowId: 'w', cost: 0 })),
  whatIfPresetImageGen: vi.fn(async () => ({ cost: 1, ready: true })),
  getOrchestratorToken: vi.fn(async () => 'token'),
  enhancePrompt: vi.fn(async () => ({})),
}));

vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: h.getOrchestratorToken,
}));
vi.mock('~/server/services/orchestrator/experimental', () => ({
  getExperimentalFlags: vi.fn(async () => ({ experimental: false })),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationNew>()),
  buildGenerationContext: vi.fn(async () => ({ externalCtx: {}, status: {} })),
  generateFromGraph: h.generateFromGraph,
  whatIfFromGraph: h.whatIfFromGraph,
}));
vi.mock('~/server/services/orchestrator/promptEnhancement', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enhancePrompt: h.enhancePrompt,
}));
vi.mock('~/server/services/orchestrator/imageUpload', () => ({ imageUpload: h.imageUpload }));
vi.mock('~/server/services/orchestrator/preset-image-gen.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitPresetImageGen: h.submitPresetImageGen,
  whatIfPresetImageGen: h.whatIfPresetImageGen,
}));
vi.mock('~/server/services/generation-input-urls', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertGenerationInputsUsable: h.assertInputs,
}));

import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { OnboardingSteps } from '~/server/common/enums';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const USER_ID = 7;
const SOURCE = 'ab12cd34-ef56-4a7b-8c9d-0e1f2a3b4c5d';
const REF = 'https://image.civitai.com/x/cd34ab12-ef56-4a7b-8c9d-0e1f2a3b4c5d/original=true';
const refused = new TRPCError({ code: 'BAD_REQUEST', message: 'unavailable' });

const caller = (apiKeyId: number | null = null) =>
  orchestratorRouter.createCaller({
    user: {
      id: USER_ID,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      muted: false,
      bannedAt: null,
      showNsfw: false,
    },
    ip: '1.2.3.4',
    features: {},
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId,
    track: {},
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  h.assertInputs.mockRejectedValue(refused);
});

/** The single check, for the signed-in user. */
const checked = () => {
  expect(h.assertInputs).toHaveBeenCalledTimes(1);
  const [arg] = h.assertInputs.mock.calls[0] as [
    { urls: unknown[]; userId: number; entry: string; isApiCaller: boolean }
  ];
  expect(arg.userId).toBe(USER_ID);
  return arg;
};

const images = { sourceImageWidth: 512, sourceImageHeight: 512 };
const ref = { url: REF, width: 512, height: 512 };

describe('orchestrator generation inputs', () => {
  it('iterateGenerate checks the source and reference urls before anything starts', async () => {
    await expect(
      caller().iterateGenerate({
        prompt: 'a cat',
        sourceImageUrl: SOURCE,
        ...images,
        referenceImages: [ref],
      })
    ).rejects.toBe(refused);
    expect(checked()).toEqual({
      urls: [SOURCE, REF],
      userId: USER_ID,
      entry: 'iterateGenerate',
      isApiCaller: false,
    });
    expect(h.getOrchestratorToken).not.toHaveBeenCalled();
    expect(h.submitPresetImageGen).not.toHaveBeenCalled();
  });

  it('getIterateCostEstimate refuses instead of returning an estimate', async () => {
    await expect(
      caller().getIterateCostEstimate({
        sourceImage: { url: SOURCE, width: 512, height: 512 },
        referenceImages: [ref],
      })
    ).rejects.toBe(refused);
    expect(checked()).toMatchObject({ urls: [SOURCE, REF], entry: 'getIterateCostEstimate' });
    expect(h.whatIfPresetImageGen).not.toHaveBeenCalled();
  });

  it('imageUpload checks the url before the orchestrator fetches it', async () => {
    await expect(caller().imageUpload({ sourceImage: REF })).rejects.toBe(refused);
    expect(checked()).toMatchObject({ urls: [REF], entry: 'imageUpload' });
    expect(h.imageUpload).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: each route proceeds when the check passes', async () => {
    h.assertInputs.mockResolvedValue(undefined);
    await caller().imageUpload({ sourceImage: REF });
    expect(h.imageUpload).toHaveBeenCalledTimes(1);
    await caller().getIterateCostEstimate({ referenceImages: [ref] });
    expect(h.whatIfPresetImageGen).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a session', null, false],
    ['an API key', 42, true],
  ])(
    'generateFromGraph and whatIfFromGraph name their entry and %s caller',
    async (_, key, api) => {
      await caller(key)
        .generateFromGraph({ input: { prompt: 'x' } })
        .catch(() => undefined);
      await caller(key)
        .whatIfFromGraph({ prompt: 'x' })
        .catch(() => undefined);
      const gates = [h.generateFromGraph, h.whatIfFromGraph].map(
        (fn) => (fn.mock.calls[0] as unknown as [{ inputGate: unknown }])[0].inputGate
      );
      expect(gates).toEqual([
        { entry: 'generateFromGraph', isApiCaller: api },
        { entry: 'whatIfFromGraph', isApiCaller: api },
      ]);
    }
  );
});

describe('orchestrator.enhancePrompt images', () => {
  // What the generation form's images node holds: an orchestrator blob, or an image CDN url.
  const BLOB = 'https://orchestration.civitai.com/v2/consumer/blobs/ABC123.jpeg?sig=s&exp=x';
  const clientPayload = (images: string[] | null) => ({
    ecosystem: 'sdxl',
    prompt: 'a cat',
    negativePrompt: null,
    instruction: null,
    temperature: 0.7,
    preserveTriggerWords: null,
    snippetTargets: null,
    segmentPrompt: false,
    singleTake: null,
    images,
  });

  it('checks the images before the enhancement runs', async () => {
    await expect(caller().enhancePrompt(clientPayload([BLOB, REF]))).rejects.toBe(refused);
    expect(checked()).toEqual({
      urls: [BLOB, REF],
      userId: USER_ID,
      entry: 'enhancePrompt',
      isApiCaller: false,
    });
    expect(h.enhancePrompt).not.toHaveBeenCalled();
  });

  it.each([
    ['a data URI', 'data:image/png;base64,iVBORw0KGgo='],
    [
      'raw base64',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    ],
    ['an AIR', 'urn:air:sdxl:image:civitai:1@1'],
  ])('refuses %s as an image at the input', async (_, image) => {
    h.assertInputs.mockResolvedValue(undefined);
    await expect(caller().enhancePrompt(clientPayload([image]))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(h.enhancePrompt).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: the payload the client sends runs when the check passes', async () => {
    h.assertInputs.mockResolvedValue(undefined);
    await caller().enhancePrompt(clientPayload([BLOB, REF]));
    await caller().enhancePrompt(clientPayload(null));
    expect(h.enhancePrompt).toHaveBeenCalledTimes(2);
  });
});
