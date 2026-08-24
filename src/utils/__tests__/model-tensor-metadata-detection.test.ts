import { describe, expect, it } from 'vitest';
import { getDominantFpFromDtypes } from '~/utils/file-helpers';
import {
  analyzeModelTensors,
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

describe('analyzeModelTensors', () => {
  const tensor = (name: string, dtype = 'BF16') => ({
    name,
    shape: [2, 2],
    dtype,
    sizeBytes: 8,
  });

  // Nothing else proves the detector is ever CALLED. Without this, changing the field to
  // `undefined` — or deleting it — leaves every other suite green while type correction
  // silently never fires again, because the summary cache drops `tensors[]` and the
  // correction has no other way back to the names.
  it('populates detectedModelType for a safetensors analysis', () => {
    const analysis = analyzeModelTensors(
      'SafeTensor',
      [tensor('encoder.conv_in.weight'), tensor('decoder.conv_out.weight')],
      { estimateVram: false }
    );

    expect(analysis.detectedModelType).toBe(null);

    const vae = analyzeModelTensors(
      'SafeTensor',
      [
        tensor('encoder.conv_in.weight'),
        tensor('encoder.down.0.block.0.norm1.weight'),
        tensor('decoder.conv_out.weight'),
        tensor('decoder.up.0.block.0.norm1.weight'),
        tensor('quant_conv.weight'),
        tensor('post_quant_conv.weight'),
      ],
      { estimateVram: false }
    );

    expect(vae.detectedModelType).toBe('VAE');
  });

  it('never claims a detected type for GGUF, whose names follow other conventions', () => {
    const analysis = analyzeModelTensors(
      'GGUF',
      [
        tensor('encoder.conv_in.weight'),
        tensor('encoder.down.0.block.0.norm1.weight'),
        tensor('decoder.conv_out.weight'),
        tensor('decoder.up.0.block.0.norm1.weight'),
        tensor('quant_conv.weight'),
        tensor('post_quant_conv.weight'),
      ],
      { estimateVram: false }
    );

    expect(analysis.detectedModelType).toBe(null);
  });
});

describe('getDominantFpFromDtypes', () => {
  // 🔴 A dtype whose byte count we could not measure must never win. NaN poisons its
  // accumulator and `NaN > bestBytes` is false against every value including the initial
  // -1, which is what makes it lose. Coercing NaN to 0 — the obvious "tidy-up" — lets it
  // win outright when it is the only mapped dtype, so the upload form would auto-fill a
  // precision derived from a header it could not read.
  it('lets a measurable dtype beat an unmeasurable one', () => {
    expect(
      getDominantFpFromDtypes([
        { dtype: 'F32', bytes: Number.NaN },
        { dtype: 'BF16', bytes: 8 },
      ])
    ).toBe('bf16');
  });

  it('returns null when every mapped dtype is unmeasurable', () => {
    expect(getDominantFpFromDtypes([{ dtype: 'F32', bytes: Number.NaN }])).toBe(null);
  });
});
