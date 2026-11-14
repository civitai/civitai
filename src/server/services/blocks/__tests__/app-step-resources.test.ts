import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { checkAppStepResources } from '~/server/services/blocks/app-step-resources';

const VERSIONS = [
  { id: 10, baseModel: 'SDXL 1.0' },
  { id: 11, baseModel: 'SDXL Turbo' },
  { id: 100, baseModel: 'Flux.2 D' },
];
const civitai = (versionId: number) => `urn:air:sdxl:lora:civitai:1@${versionId}`;

beforeEach(() => {
  dbMock.dbRead.modelVersion.findMany.mockClear();
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
    await expect(checkAppStepResources(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
    await expect(checkAppStepResources(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['a Civitai AIR without a version', 'urn:air:sdxl:lora:civitai:1'],
    ['a Civitai AIR with a malformed version', 'urn:air:sdxl:lora:civitai:1@0'],
  ])('refuses %s before looking it up', async (_, model) => {
    await expect(checkAppStepResources({ model })).rejects.toThrow(/must name a model version/);
    expect(dbMock.dbRead.modelVersion.findMany).not.toHaveBeenCalled();
  });

  it('refuses a version on a base model no app may use', async () => {
    await expect(checkAppStepResources({ model: civitai(100) })).rejects.toMatchObject({
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
      await expect(checkAppStepResources(input)).resolves.toEqual({ capOutput: true });
    }
  );

  it('allows a training-data zip from a Hugging Face dataset repo', async () => {
    await expect(
      checkAppStepResources({
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
    await expect(checkAppStepResources({ sourceUrl })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('leaves prompts, timecodes, links, image URLs and orchestrator outputs alone', async () => {
    await expect(
      checkAppStepResources({
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
});
