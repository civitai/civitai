import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { checkAppStepResources } from '~/server/services/blocks/app-step-resources';

const VIEWER = 7;
const OWNER = 8;
const MODERATOR = 9;
const published = { status: 'Published', availability: 'Public', model: { userId: OWNER } };
const VERSIONS = [
  { id: 10, baseModel: 'SDXL 1.0', ...published },
  { id: 11, baseModel: 'SDXL Turbo', ...published },
  { id: 100, baseModel: 'Flux.2 D', ...published },
  { id: 20, baseModel: 'SDXL 1.0', ...published, availability: 'Private' },
  { id: 21, baseModel: 'SDXL 1.0', ...published, status: 'Draft' },
  { id: 22, baseModel: 'SDXL 1.0', ...published, status: 'Training' },
  { id: 23, baseModel: 'SDXL 1.0', ...published, usageControl: 'InternalGeneration' },
];
const civitai = (versionId: number) => `urn:air:sdxl:lora:civitai:1@${versionId}`;
const check = (input: unknown, viewerId = VIEWER) => checkAppStepResources(input, viewerId);

beforeEach(() => {
  dbMock.dbRead.modelVersion.findMany.mockClear();
  dbMock.dbRead.user.findUnique.mockReset();
  dbMock.dbRead.user.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => ({ isModerator: where.id === MODERATOR })) as never);
  dbMock.dbRead.modelVersion.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => VERSIONS.filter((v) => where.id.in.includes(v.id))) as never);
});

describe('checkAppStepResources', () => {
  it.each([
    ['an AIR', { model: 'urn:air:flux2:diffusion_model:huggingface:org/repo@main/x.safetensors' }],
    ['a URL deep in the input', { a: [{ b: 'https://huggingface.co/org/repo/x.safetensors' }] }],
    [
      'an AIR with surrounding whitespace',
      { model: ' urn:air:sdxl:lora:huggingface:org/repo@main ' },
    ],
  ])('refuses a Hugging Face resource given as %s', async (_, input) => {
    await expect(check(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['another source', { model: 'urn:air:sdxl:checkpoint:modelscope:org/repo@1' }],
    ['another source without the urn prefix', { model: 'sdxl:checkpoint:modelscope:org/repo@1' }],
    ['another source in short form', { model: 'modelscope:org/repo@1' }],
    ['a version that does not exist', { model: civitai(99) }],
    ['a URL to a weights file', { model: 'https://example.com/weights/model.safetensors?x=1' }],
    ['a URL as a map key', { loras: { 'https://example.com/lora': 1 } }],
    ['a weights URL with an encoded path', { model: 'https://example.com/m%2Esafetensors#x' }],
    ['a weights URL under another scheme', { model: 's3://bucket/model.safetensors' }],
    ['a weights URL without its slashes', { model: 'https:example.com/model.gguf' }],
    ['an AIR the parser cannot read', { model: 'urn:air:sdxl:checkpoint:civitai:1@2 extra' }],
    ['another source as a map key', { loras: { 'modelscope:org/repo': 1 } }],
  ])('refuses %s', async (_, input) => {
    await expect(check(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['a Civitai AIR without a version', 'urn:air:sdxl:lora:civitai:1'],
    ['a Civitai AIR with a malformed version', 'urn:air:sdxl:lora:civitai:1@0'],
  ])('refuses %s before looking it up', async (_, model) => {
    await expect(check({ model })).rejects.toThrow(/must name a model version/);
    expect(dbMock.dbRead.modelVersion.findMany).not.toHaveBeenCalled();
  });

  it('refuses a version on a base model no app may use', async () => {
    await expect(check({ model: civitai(100) })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it.each([
    ['an AIR', { model: civitai(11) }],
    ['a file-pinned AIR', { model: `${civitai(11)}+22` }],
    ['a short-form AIR', { model: 'civitai:1@11' }],
    ['a LoRA map key', { loras: { [civitai(11)]: 0.8 } }],
  ])(
    'caps a step naming a version on a base model that restricts mature generation as %s',
    async (_, input) => {
      await expect(check(input)).resolves.toEqual({ capOutput: true });
    }
  );

  it('allows a training-data zip from a Hugging Face dataset repo', async () => {
    await expect(
      check({
        sourceUrl:
          'urn:air:other:other:huggingface:datasets/Civitai/orchestration-samples@e86d02/sample-training-dataset.zip',
      })
    ).resolves.toEqual({ capOutput: false });
  });

  it.each([
    ['as weights', 'urn:air:sdxl:checkpoint:huggingface:datasets/org/repo@main/model.zip'],
    [
      'as a non-zip file',
      'urn:air:other:other:huggingface:datasets/org/repo@main/model.safetensors',
    ],
    ['from a model repo', 'urn:air:other:other:huggingface:org/repo@main/x.zip'],
    ['with a query after .zip', 'urn:air:other:other:huggingface:datasets/org/repo@main/x?.zip'],
  ])('refuses a Hugging Face file named %s', async (_, sourceUrl) => {
    await expect(check({ sourceUrl })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('leaves prompts, timecodes, links, image URLs and orchestrator outputs alone', async () => {
    await expect(
      check({
        prompt: 'a poster in the huggingface style',
        mood: 'mood:calm',
        start: '00:00:05:00',
        contact: 'mailto:a@b.com',
        image: 'https://orchestration.civitai.com/v2/consumer/blobs/abc@2x.png',
        reference: 'http://example.com/ref@1.jpg',
        lora: 'urn:air:sdxl:lora:orchestrator:job-1@file.safetensors',
        model: civitai(10),
      })
    ).resolves.toEqual({ capOutput: false });
  });

  describe('the generation access rule', () => {
    it.each([
      ['a Private version', 20],
      ['a Draft version', 21],
      ['a Training version', 22],
      ['an InternalGeneration version', 23],
    ])('refuses %s to a viewer who does not own it', async (_, id) => {
      await expect(check({ model: civitai(id) })).rejects.toThrow(
        `model version ${id} is not available for generation`
      );
    });

    it('refuses a restricted version named alongside a usable one', async () => {
      await expect(check({ model: civitai(10), lora: civitai(20) })).rejects.toThrow(
        'model version 20 is not available for generation'
      );
    });

    it.each([
      'https:civitai:1@20',
      'http:checkpoint:civitai:1@20',
      'sdxl://lora:civitai:1@20',
      'urn://air:civitai:1@20',
    ])('refuses a restricted version named by the URL-shaped AIR %s', async (model) => {
      await expect(check({ model })).rejects.toThrow(
        'model version 20 is not available for generation'
      );
    });

    it('refuses a restricted version named as a LoRA map key', async () => {
      await expect(check({ loras: { [civitai(20)]: 0.8 } })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('refuses an InternalGeneration version to its owner', async () => {
      await expect(check({ model: civitai(23) }, OWNER)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });

    it('allows a Private version to its owner', async () => {
      await expect(check({ model: civitai(20) }, OWNER)).resolves.toEqual({ capOutput: false });
    });

    // Deliberate (see checkAppStepResources): do not add a moderator exemption back.
    it.each([
      ['a Private version', 20],
      ['a Draft version', 21],
    ])("refuses a moderator running an app that names someone else's %s", async (_, id) => {
      await expect(check({ model: civitai(id) }, MODERATOR)).rejects.toThrow(
        `model version ${id} is not available for generation`
      );
    });

    it('allows a public version', async () => {
      await expect(check({ model: civitai(10) })).resolves.toEqual({ capOutput: false });
    });

    // Deliberate (see checkAppStepResources): do not widen this check to the full canGenerate rule.
    it('allows a training step naming a public base checkpoint', async () => {
      dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
        { id: 10, baseModel: 'SDXL 1.0', ...published, covered: false },
      ] as never);
      await expect(
        check({
          engine: 'ai-toolkit',
          model: 'urn:air:sdxl:checkpoint:civitai:101055@10',
          trainingData: 'https://orchestration.civitai.com/v2/consumer/blobs/data.zip',
        })
      ).resolves.toEqual({ capOutput: false });
    });
  });
});
