import { describe, expect, it } from 'vitest';
import {
  analyzeModelTensors,
  detectModelTypeFromTensors,
  getDominantWeightPrecision,
  getModelFileTypeCorrection,
  weightPrecisionToModelFileFp,
} from '~/utils/model-tensor-metadata';

describe('getDominantWeightPrecision', () => {
  it('combines float8 variants into FP8 before comparing their weight bytes', () => {
    expect(
      getDominantWeightPrecision([
        { dtype: 'F8_E4M3FN', count: 2, bytes: 40 },
        { dtype: 'F8_E5M2', count: 1, bytes: 30 },
        { dtype: 'BF16', count: 1, bytes: 60 },
      ])
    ).toBe('FP8');
  });

  it.each([
    ['BF16', 'BF16'],
    ['F16', 'FP16'],
    ['Q4_K', 'Q4'],
    ['Q8_0', 'Q8'],
    ['IQ4_XS', 'IQ4'],
  ])('normalizes %s as %s', (dtype, expected) => {
    expect(getDominantWeightPrecision([{ dtype, count: 1, bytes: 100 }])).toBe(expected);
  });

  it('returns null when no dtype accounts for any weight bytes', () => {
    expect(getDominantWeightPrecision([{ dtype: 'F16', count: 0, bytes: 0 }])).toBeNull();
  });
});

describe('weightPrecisionToModelFileFp', () => {
  it.each([
    ['FP32', 'fp32'],
    ['FP64', 'fp32'],
    ['FP16', 'fp16'],
    ['BF16', 'bf16'],
    ['FP8', 'fp8'],
    ['NF4', 'nf4'],
  ])('maps %s to %s', (precision, expected) => {
    expect(weightPrecisionToModelFileFp(precision)).toBe(expected);
  });

  it('does not force unsupported tensor precisions into the file fp field', () => {
    expect(weightPrecisionToModelFileFp('Q4')).toBeNull();
  });
});

describe('detectModelTypeFromTensors', () => {
  const detect = (...names: string[]) =>
    detectModelTypeFromTensors(names.map((name) => ({ name })));

  it('recognizes a full diffusion checkpoint before its individual components', () => {
    expect(
      detect(
        'model.diffusion_model.input_blocks.0.0.weight',
        'model.diffusion_model.middle_block.0.weight',
        'first_stage_model.encoder.conv_in.weight',
        'cond_stage_model.transformer.text_model.encoder.layers.0.weight'
      )
    ).toBe('Checkpoint');
  });

  it('lets a specific ControlNet signature outrank bundled checkpoint namespaces', () => {
    expect(
      detect(
        'model.diffusion_model.input_blocks.0.0.weight',
        'first_stage_model.encoder.conv_in.weight',
        'controlnet_blocks.0.weight'
      )
    ).toBe('ControlNet');
  });

  it.each([
    [
      'LoRA',
      [
        'base_model.model.blocks.0.attn.to_q.lora_A.weight',
        'base_model.model.blocks.0.attn.to_q.lora_B.weight',
      ],
    ],
    [
      'VAE',
      [
        'encoder.downsamples.0.residual.0.weight',
        'encoder.downsamples.1.residual.0.weight',
        'decoder.upsamples.0.residual.0.weight',
        'decoder.upsamples.1.residual.0.weight',
      ],
    ],
    [
      'TextEncoder',
      [
        'text_model.embeddings.token_embedding.weight',
        'text_model.encoder.layers.0.self_attn.q_proj.weight',
      ],
    ],
    [
      'VisionEncoder',
      [
        'vision_model.embeddings.patch_embedding.weight',
        'vision_model.encoder.layers.0.self_attn.q_proj.weight',
      ],
    ],
    ['UNet', ['input_blocks.0.0.weight', 'middle_block.0.weight', 'output_blocks.0.0.weight']],
    ['DiffusionModel', ['double_blocks.0.img_attn.qkv.weight', 'single_blocks.0.linear1.weight']],
    ['ControlNet', ['controlnet_blocks.0.weight', 'controlnet_blocks.1.weight']],
  ])('recognizes %s tensor namespaces', (expected, names) => {
    expect(detect(...names)).toBe(expected);
  });

  it('leaves ambiguous encoder-decoder headers unclassified', () => {
    expect(
      detect(
        'encoder.block.0.layer.0.weight',
        'encoder.block.1.layer.0.weight',
        'decoder.block.0.layer.0.weight',
        'decoder.block.1.layer.0.weight'
      )
    ).toBeNull();
  });
});

describe('getModelFileTypeCorrection', () => {
  it.each([
    ['VAE', 'VAE', 'Other', 'Model'],
    ['VAE', 'Checkpoint', 'Model', 'VAE'],
    ['TextEncoder', 'TextEncoder', 'Text Encoder', 'Model'],
    ['TextEncoder', 'Checkpoint', 'Other', 'Text Encoder'],
    ['VisionEncoder', 'CLIP', 'Text Encoder', 'Vision Encoder'],
    ['UNet', 'UNet', 'UNet', 'Model'],
    ['DiffusionModel', 'Checkpoint', 'Other', 'Diffusion Model'],
    ['ControlNet', 'Controlnet', 'ControlNet', 'Model'],
    ['LoRA', 'Checkpoint', 'Other', 'Enhancement LoRA'],
  ])('corrects %s in a %s model from %s to %s', (detected, modelType, current, expected) => {
    expect(
      getModelFileTypeCorrection({
        detectedModelType: detected as Parameters<
          typeof getModelFileTypeCorrection
        >[0]['detectedModelType'],
        modelType,
        currentFileType: current,
      })
    ).toBe(expected);
  });

  it('preserves compatible distinctions that tensor names cannot prove', () => {
    expect(
      getModelFileTypeCorrection({
        detectedModelType: 'Checkpoint',
        modelType: 'Checkpoint',
        currentFileType: 'Pruned Model',
      })
    ).toBeNull();
    expect(
      getModelFileTypeCorrection({
        detectedModelType: 'LoRA',
        modelType: 'LORA',
        currentFileType: 'Model',
      })
    ).toBeNull();
  });
});

describe('analyzeModelTensors', () => {
  it('includes the dominant weight precision in the cached analysis', () => {
    const analysis = analyzeModelTensors(
      'GGUF',
      [
        { name: 'layer.0.weight', shape: [1], dtype: 'Q4_K', sizeBytes: 90 },
        { name: 'layer.0.scale', shape: [1], dtype: 'Q6_K', sizeBytes: 10 },
      ],
      { estimateVram: false }
    );

    expect(analysis.weightPrecision).toBe('Q4');
    expect(analysis.detectedModelType).toBeNull();
  });
});
