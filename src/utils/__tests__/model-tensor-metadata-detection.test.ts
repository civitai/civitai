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

describe('detectModelTypeFromTensors — rule precedence', () => {
  /**
   * 🔴 These fixtures satisfy MORE THAN ONE rule on purpose, and that is the whole point.
   * Every other fixture in this file is the minimum that matches exactly one rule, so it
   * cannot tell you anything about the ORDER the rules are tried in — and order is the
   * entire design of this function. A real full checkpoint carries all three UNet block
   * families as well as `first_stage_model.`, so moving the UNet check above the Checkpoint
   * check would misfile every checkpoint on the site while the minimal fixtures stayed green.
   */
  const fullCheckpoint = named(
    'model.diffusion_model.input_blocks.0.0.weight',
    'model.diffusion_model.middle_block.0.in_layers.0.weight',
    'model.diffusion_model.output_blocks.0.0.weight',
    'first_stage_model.encoder.conv_in.weight',
    'first_stage_model.decoder.conv_out.weight',
    'cond_stage_model.transformer.text_model.embeddings.token_embedding.weight',
    'cond_stage_model.transformer.text_model.encoder.layers.0.mlp.fc1.weight'
  );

  it('calls a full checkpoint a Checkpoint, not a UNet or a TextEncoder', () => {
    expect(detectModelTypeFromTensors(fullCheckpoint)).toBe('Checkpoint');
  });

  it('calls a ControlNet a ControlNet even when it carries checkpoint-shaped blocks', () => {
    expect(
      detectModelTypeFromTensors([
        ...named('control_model.input_blocks.0.0.weight'),
        ...fullCheckpoint,
      ])
    ).toBe('ControlNet');
  });

  it('calls a LoRA a LoRA before anything else it also matches', () => {
    expect(
      detectModelTypeFromTensors([
        ...named(
          'lora_unet_input_blocks_1.lora_down.weight',
          'lora_unet_input_blocks_1.lora_up.weight'
        ),
        ...fullCheckpoint,
      ])
    ).toBe('LoRA');
  });

  it('prefers VisionEncoder over TextEncoder for a file carrying both towers', () => {
    // A CLIP model has both; the vision check runs first and that is deliberate.
    expect(
      detectModelTypeFromTensors(
        named(
          'vision_model.embeddings.patch_embedding.weight',
          'vision_model.encoder.layers.0.mlp.fc1.weight',
          'text_model.embeddings.token_embedding.weight',
          'text_model.encoder.layers.0.mlp.fc1.weight'
        )
      )
    ).toBe('VisionEncoder');
  });
});

describe('detectModelTypeFromTensors — remaining branches', () => {
  it.each([
    ['control_model.', 'control_model.input_blocks.0.0.weight'],
    ['controlnet_blocks.', 'controlnet_blocks.0.weight'],
    ['controlnet_down_blocks.', 'controlnet_down_blocks.0.weight'],
    ['controlnet_mid_block.', 'controlnet_mid_block.weight'],
    ['zero_convs.', 'zero_convs.0.0.weight'],
    ['input_hint_block.', 'input_hint_block.0.weight'],
  ])('detects a ControlNet from %s', (_label, name) => {
    expect(detectModelTypeFromTensors(named(name))).toBe('ControlNet');
  });

  it('detects a decoder-style LLM text encoder', () => {
    expect(
      detectModelTypeFromTensors(
        named(
          'model.embed_tokens.weight',
          'model.layers.0.mlp.up_proj.weight',
          'model.layers.1.mlp.up_proj.weight'
        )
      )
    ).toBe('TextEncoder');
  });

  it('detects a T5 text encoder', () => {
    expect(
      detectModelTypeFromTensors(
        named(
          'shared.weight',
          'encoder.block.0.layer.0.SelfAttention.q.weight',
          'encoder.block.1.layer.0.SelfAttention.q.weight'
        )
      )
    ).toBe('TextEncoder');
  });

  it('detects an MMDiT joint-block transformer', () => {
    expect(
      detectModelTypeFromTensors(
        named('joint_blocks.0.context_block.attn.qkv.weight', 'x_embedder.proj.weight')
      )
    ).toBe('DiffusionModel');
  });

  it('detects a diffusers-style transformer', () => {
    expect(
      detectModelTypeFromTensors(
        named('transformer_blocks.0.attn.to_q.weight', 'patch_embed.proj.weight')
      )
    ).toBe('DiffusionModel');
  });
});

describe('getModelFileTypeCorrection — remaining mappings', () => {
  /**
   * 🔴 The LORA branch compares against the Prisma enum spelling, which is `LORA`. Writing
   * it `'LoRA'` — the spelling used everywhere in prose, and in this function's own
   * DetectedModelTensorType union two lines up — relabels every LoRA model's own weights
   * file as an Enhancement LoRA across the whole corpus. `modelType` is typed `string`, so
   * the typechecker does not catch it. This test is the only thing that does.
   */
  it.each(['LORA', 'DoRA', 'LoCon'])('leaves a %s model own weights file alone', (modelType) => {
    expect(
      getModelFileTypeCorrection({ detectedModelType: 'LoRA', modelType, currentFileType: 'Model' })
    ).toBe(null);
  });

  it.each([
    ['TextEncoder', 'Checkpoint', 'Text Encoder'],
    ['TextEncoder', 'TextEncoder', 'Model'],
    ['VisionEncoder', 'Checkpoint', 'CLIPVision'],
    ['VisionEncoder', 'CLIPVision', 'Model'],
    ['VisionEncoder', 'CLIP', 'Vision Encoder'],
    ['UNet', 'Checkpoint', 'UNet'],
    ['UNet', 'UNet', 'Model'],
    ['DiffusionModel', 'UNet', 'Model'],
    ['ControlNet', 'Checkpoint', 'ControlNet'],
    ['ControlNet', 'Controlnet', 'Model'],
  ] as const)('maps %s on a %s model to %s', (detectedModelType, modelType, expected) => {
    expect(
      getModelFileTypeCorrection({ detectedModelType, modelType, currentFileType: 'Other' })
    ).toBe(expected);
  });
});
