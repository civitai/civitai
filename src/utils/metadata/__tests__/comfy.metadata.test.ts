import { describe, it, expect } from 'vitest';
import { comfyMetadataProcessor } from '../comfy.metadata';

const parse = (exif: Record<string, unknown>) =>
  comfyMetadataProcessor.parse(exif as any) as Record<string, any>;

const baseExtra = {
  prompt: 'a cat',
  negativePrompt: '',
  cfgScale: 7,
  steps: 20,
  seed: 123,
  sampler: 'Euler',
  denoise: 1,
  resources: [],
};

describe('comfyMetadataProcessor - engine + workflow', () => {
  it('sets engine=ComfyUI when the workflow carries no civitai airs', () => {
    const meta = parse({
      prompt: '{}',
      workflow: '{}',
      extraMetadata: { ...baseExtra, workflowId: 'txt2img' },
    });
    expect(meta.engine).toBe('ComfyUI');
  });

  it('sets engine=Civitai when the workflow carries civitai airs', () => {
    const meta = parse({
      prompt: '{}',
      workflow: '{"extra":{"airs":["urn:air:sdxl:checkpoint:civitai:123@456"]}}',
      extraMetadata: { ...baseExtra, workflowId: 'txt2img' },
    });
    expect(meta.engine).toBe('Civitai');
  });

  it('preserves the full workflow key (variant not stripped in the parser)', () => {
    const meta = parse({
      prompt: '{}',
      workflow: '{}',
      extraMetadata: { ...baseExtra, workflowId: 'img2img:hires-fix' },
    });
    expect(meta.workflow).toBe('img2img:hires-fix');
  });

  it('falls back to the `workflow` field when workflowId is absent', () => {
    const meta = parse({
      prompt: '{}',
      workflow: '{}',
      extraMetadata: { ...baseExtra, workflow: 'txt2img:draft' },
    });
    expect(meta.workflow).toBe('txt2img:draft');
  });
});
