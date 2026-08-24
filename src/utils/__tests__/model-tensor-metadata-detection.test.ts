import { describe, expect, it } from 'vitest';
import {
  detectModelTypeFromTensors,
  getModelFileTypeCorrection,
} from '~/utils/model-tensor-metadata';

const named = (...names: string[]) => names.map((name) => ({ name }));

describe('detectModelTypeFromTensors', () => {
  it('detects a LoRA from its paired down/up weights', () => {
    expect(
      detectModelTypeFromTensors(
        named(
          'lora_unet_input_blocks_1.lora_down.weight',
          'lora_unet_input_blocks_1.lora_up.weight'
        )
      )
    ).toBe('LoRA');
  });

  it('does not call a half-paired LoRA a LoRA', () => {
    expect(detectModelTypeFromTensors(named('lora_unet_input_blocks_1.lora_down.weight'))).toBe(
      null
    );
  });

  it('detects a full checkpoint from the diffusion namespace plus its components', () => {
    expect(
      detectModelTypeFromTensors(
        named(
          'model.diffusion_model.input_blocks.0.0.weight',
          'first_stage_model.encoder.conv_in.weight'
        )
      )
    ).toBe('Checkpoint');
  });

  it('detects a standalone VAE', () => {
    expect(
      detectModelTypeFromTensors(
        named(
          'encoder.conv_in.weight',
          'encoder.down.0.block.0.norm1.weight',
          'decoder.conv_out.weight',
          'decoder.up.0.block.0.norm1.weight',
          'quant_conv.weight',
          'post_quant_conv.weight'
        )
      )
    ).toBe('VAE');
  });

  it('detects a CLIP text encoder', () => {
    expect(
      detectModelTypeFromTensors(
        named(
          'text_model.embeddings.token_embedding.weight',
          'text_model.encoder.layers.0.mlp.fc1.weight'
        )
      )
    ).toBe('TextEncoder');
  });

  it('detects a bare UNet', () => {
    expect(
      detectModelTypeFromTensors(
        named(
          'input_blocks.0.0.weight',
          'middle_block.0.in_layers.0.weight',
          'output_blocks.0.0.weight'
        )
      )
    ).toBe('UNet');
  });

  it('detects a Flux-style diffusion transformer', () => {
    expect(
      detectModelTypeFromTensors(
        named('double_blocks.0.img_attn.qkv.weight', 'single_blocks.0.linear1.weight')
      )
    ).toBe('DiffusionModel');
  });

  it('returns null for a file it does not recognise', () => {
    expect(detectModelTypeFromTensors(named('some.random.tensor', 'another.one'))).toBe(null);
  });
});

describe('getModelFileTypeCorrection', () => {
  it('proposes nothing when the header had no opinion', () => {
    expect(
      getModelFileTypeCorrection({
        detectedModelType: null,
        modelType: 'Checkpoint',
        currentFileType: 'Other',
      })
    ).toBe(null);
  });

  it('relabels a VAE mis-filed on a checkpoint', () => {
    expect(
      getModelFileTypeCorrection({
        detectedModelType: 'VAE',
        modelType: 'Checkpoint',
        currentFileType: 'Other',
      })
    ).toBe('VAE');
  });

  it("leaves a VAE model's own weights filed as Model", () => {
    expect(
      getModelFileTypeCorrection({
        detectedModelType: 'VAE',
        modelType: 'VAE',
        currentFileType: 'Model',
      })
    ).toBe(null);
  });

  it('accepts Pruned Model as compatible with a detected checkpoint', () => {
    expect(
      getModelFileTypeCorrection({
        detectedModelType: 'Checkpoint',
        modelType: 'Checkpoint',
        currentFileType: 'Pruned Model',
      })
    ).toBe(null);
  });

  it('files a LoRA found on a non-LoRA model as an Enhancement LoRA', () => {
    expect(
      getModelFileTypeCorrection({
        detectedModelType: 'LoRA',
        modelType: 'Checkpoint',
        currentFileType: 'Model',
      })
    ).toBe('Enhancement LoRA');
  });
});
