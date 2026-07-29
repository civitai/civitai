import { describe, it, expect } from 'vitest';
import { ExifParser } from '~/utils/metadata';
import { automaticMetadataProcessor } from '~/utils/metadata/automatic.metadata';
import { comfyMetadataProcessor } from '~/utils/metadata/comfy.metadata';
import { decodeUserComment } from '~/utils/encoding-helpers';

// TODO - create a suite of tests that uses images from civitai to test the different metadata parsers

const testImageUrl =
  'https://orchestration-new.civitai.com/v2/consumer/blobs/E8S6FBPH50ENNVF2PD5XRBPXB0.jpeg?sig=CfDJ8N_qP_UguotCoWxV0GDJyrqO3glAlXP7D6Hb6iXbU9BAZ6no3Pzo0PfuPoI42wFTr-BalGCgmLC5CRJMpYU8Rpi_QqslJAMyMrcmNmeutDpUiZ-C8oAhuumEznFYdbOq3d1hQK4mW0qylzz7qmpPnTxZfJ67zOPQUvskp1Fwv_Xoh_1wKej0bllrUzLdAgpnOVnrb9LTQC8yjeYn2SRQPOFx5pYwna3qVSIXh1Oz-TN7yISHZEncedPwDrwyN91iwRqWujthjJHfyJ_ziykqJCdXmyi5mzp1fp5pzRTRjWOx&exp=2027-02-26T17:34:23.6860202Z';

// The actual generationDetails string extracted from the test image.
// The Civitai metadata contains nested objects (aspectRatio, resources array).
const realGenerationDetails = `an ancient warrior princess with sad face, from the side, looking up, in rain, a small stream of water running down over her face, high contrast shadowing,
 candid style. high contrast, grain effect prominent throughout image, high contrast lighting creating dramatic shadows, grainy film-like texture, nipples
Negative prompt: photo , photography, bad quality, bad anatomy, worst quality, low quality, low resolution, extra fingers, blur, blurry, ugly, wrong proportions, watermark, image artifacts, lowres, ugly, jpeg artifacts, deformed, noisy image
Steps: 40, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 2027225909, Size: 1216x832, Clip skip: 2, Created Date: 2026-02-25T22:09:08.8166925Z, Civitai resources: [{"type":"checkpoint","modelVersionId":1714314,"modelName":"Plant Milk \\uD83C\\uDF3F - Model Suite","modelVersionName":"Hemp II"}], Civitai metadata: {"workflow":"txt2img","output":"image","input":"text","priority":"low","outputFormat":"jpeg","ecosystem":"Illustrious","quantity":4,"aspectRatio":{"value":"3:2","width":1216,"height":832},"negativePrompt":"photo , photography, bad quality, bad anatomy, worst quality, low quality, low resolution, extra fingers, blur, blurry, ugly, wrong proportions, watermark, image artifacts, lowres, ugly, jpeg artifacts, deformed, noisy image","sampler":"DPM++ 2M Karras","cfgScale":7,"steps":40,"clipSkip":2,"seed":2027225909,"enhancedCompatibility":false,"prompt":"an ancient warrior princess with sad face, from the side, looking up, in rain, a small stream of water running down over her face, high contrast shadowing,\\n candid style. high contrast, grain effect prominent throughout image, high contrast lighting creating dramatic shadows, grainy film-like texture, nipples","resources":[{"modelVersionId":1714314,"strength":1,"type":"Checkpoint"}]}`;

// This test fetches a real image over HTTP. Skipped by default to keep the
// unit suite hermetic; run with EXIF_NETWORK_TESTS=1 to exercise it locally.
const networkTest = process.env.EXIF_NETWORK_TESTS === '1' ? it : it.skip;

describe('ExifParser - test image URL', () => {
  networkTest('should parse metadata from the test image without error', async () => {
    const parser = await ExifParser(testImageUrl);
    const parsed = parser.parse();

    expect(parsed).toBeDefined();
    expect(parsed?.prompt).toContain('ancient warrior princess');
    expect(parsed?.extra).toBeDefined();
    expect(parsed?.extra).toHaveProperty('workflow', 'txt2img');
    expect(parsed?.extra).toHaveProperty('ecosystem', 'Illustrious');
  });
});

describe('automaticMetadataProcessor - Civitai metadata with nested JSON', () => {
  it('parses Civitai metadata with nested objects from real image data', () => {
    const exif = { generationDetails: realGenerationDetails, parameters: realGenerationDetails };

    expect(automaticMetadataProcessor.canParse(exif)).toBe(true);

    const result = automaticMetadataProcessor.parse(exif);
    expect(result.extra).toBeDefined();
    expect(result.extra).toHaveProperty('workflow', 'txt2img');
    expect(result.extra).toHaveProperty('ecosystem', 'Illustrious');
    expect(result.extra?.aspectRatio).toEqual({ value: '3:2', width: 1216, height: 832 });
    expect(result.extra?.resources).toEqual([
      { modelVersionId: 1714314, strength: 1, type: 'Checkpoint' },
    ]);
  });

  it('parses Civitai metadata with nested objects (minimal case)', () => {
    const metadata = `Steps: 20, Sampler: Euler, Civitai metadata: {"flat": "ok", "nested": {"inner": "value"}}`;
    const exif = { generationDetails: metadata, parameters: metadata };

    expect(automaticMetadataProcessor.canParse(exif)).toBe(true);

    const result = automaticMetadataProcessor.parse(exif);
    expect(result.extra).toEqual({ flat: 'ok', nested: { inner: 'value' } });
  });

  it('parses flat Civitai metadata', () => {
    const metadata = `Steps: 20, Sampler: Euler, Civitai metadata: {"remixOfId": 123, "workflow": "txt2img"}`;
    const exif = { generationDetails: metadata, parameters: metadata };

    expect(automaticMetadataProcessor.canParse(exif)).toBe(true);

    const result = automaticMetadataProcessor.parse(exif);
    expect(result.extra).toEqual({ remixOfId: 123, workflow: 'txt2img' });
  });

  it('does not leave Civitai metadata fragments in other parsed fields', () => {
    const metadata = `Steps: 20, Sampler: Euler, Size: 512x512, Civitai metadata: {"workflow": "txt2img", "nested": {"a": 1}}`;
    const exif = { generationDetails: metadata, parameters: metadata };

    const result = automaticMetadataProcessor.parse(exif);
    expect(result.steps).toBe('20');
    expect(result.sampler).toBe('Euler');
    // The processor extracts "Size" into width/height and deletes the original key.
    expect(result.width).toBe(512);
    expect(result.height).toBe(512);
    expect(result['Size']).toBeUndefined();
    // Civitai metadata should be fully removed from details line, not leaking into other fields
    expect(result['Civitai metadata']).toBeUndefined();
  });
});

describe('decodeUserComment - endianness and encoding', () => {
  const prefix = [0x55, 0x4e, 0x49, 0x43, 0x4f, 0x44, 0x45, 0x00]; // "UNICODE\0"
  const testString = 'Steps: 4, Sampler: Euler, Character: 中';

  it('decodes UTF-16BE correctly (standard EXIF format)', () => {
    // Encode testString in UTF-16BE
    const content = [];
    for (let i = 0; i < testString.length; i++) {
      const code = testString.charCodeAt(i);
      content.push((code >> 8) & 0xff);
      content.push(code & 0xff);
    }
    const buffer = new Uint8Array(prefix.concat(content));
    const result = decodeUserComment(buffer);
    expect(result).toBe(testString);
  });

  it('decodes UTF-16LE correctly', () => {
    // Encode testString in UTF-16LE
    const content = [];
    for (let i = 0; i < testString.length; i++) {
      const code = testString.charCodeAt(i);
      content.push(code & 0xff);
      content.push((code >> 8) & 0xff);
    }
    const buffer = new Uint8Array(prefix.concat(content));
    const result = decodeUserComment(buffer);
    expect(result).toBe(testString);
  });

  it('decodes UTF-16BE with BOM correctly', () => {
    // BOM: 0xFE, 0xFF
    const content = [0xfe, 0xff];
    for (let i = 0; i < testString.length; i++) {
      const code = testString.charCodeAt(i);
      content.push((code >> 8) & 0xff);
      content.push(code & 0xff);
    }
    const buffer = new Uint8Array(prefix.concat(content));
    const result = decodeUserComment(buffer);
    expect(result).toBe(testString);
  });

  it('decodes UTF-16LE with BOM correctly', () => {
    // BOM: 0xFF, 0xFE
    const content = [0xff, 0xfe];
    for (let i = 0; i < testString.length; i++) {
      const code = testString.charCodeAt(i);
      content.push(code & 0xff);
      content.push((code >> 8) & 0xff);
    }
    const buffer = new Uint8Array(prefix.concat(content));
    const result = decodeUserComment(buffer);
    expect(result).toBe(testString);
  });
});

describe('automaticMetadataProcessor - single-line and delimited metadata parsing', () => {
  it('parses metadata with dot before Negative prompt and Steps', () => {
    const rawMetadata = `Parameters                      : <lora:generic_lora_a:1> generic prompt text <lora:generic_lora_b:1> more prompt text.Negative prompt: negative prompt text, low quality.Steps: 24, Sampler: Euler a, Schedule type: Automatic, CFG scale: 4, Seed: 2366756367, Size: 640x980, Model hash: 23d793a158, Model: GenericModel, Wildcard prompt: "  <lora:generic_lora_a:1> generic prompt text <lora:generic_lora_b:1> more prompt text", Lora hashes: "generic_lora_a: bed61886a493", Version: v1.9.3`;
    const exif = { generationDetails: rawMetadata, parameters: rawMetadata };

    expect(automaticMetadataProcessor.canParse(exif)).toBe(true);

    const result = automaticMetadataProcessor.parse(exif);
    expect(result.prompt).toBe(
      '<lora:generic_lora_a:1> generic prompt text <lora:generic_lora_b:1> more prompt text'
    );
    expect(result.negativePrompt).toBe('negative prompt text, low quality');
    expect(result.steps).toBe('24');
    expect(result.sampler).toBe('Euler a');
    expect(result.cfgScale).toBe('4');
    expect(result.seed).toBe('2366756367');
    expect(result.width).toBe(640);
    expect(result.height).toBe(980);
    expect(result.Model).toBe('GenericModel');
  });

  it('parses metadata with comma-dot before Negative prompt and dot before Steps', () => {
    const rawMetadata = `Parameters                      : A generic prompt text.,.Negative prompt: .Steps: 4, Sampler: Euler, CFG scale: 1.0, Seed: 1099633777240739, Size: 1088x1920, Model: generic_model_v1, Version: ComfyUI, Civitai resources: [{"modelName":"Generic Model","versionName":"v1","air":"urn:air:zimageturbo:checkpoint:civitai:12345@67890"}]`;
    const exif = { generationDetails: rawMetadata, parameters: rawMetadata };

    expect(automaticMetadataProcessor.canParse(exif)).toBe(true);

    const result = automaticMetadataProcessor.parse(exif);
    expect(result.prompt).toBe('A generic prompt text');
    expect(result.negativePrompt).toBe('');
    expect(result.steps).toBe('4');
    expect(result.sampler).toBe('Euler');
    expect(result.cfgScale).toBe('1.0');
    expect(result.seed).toBe('1099633777240739');
    expect(result.width).toBe(1088);
    expect(result.height).toBe(1920);
    expect(result.Model).toBe('generic_model_v1');
    expect(result.civitaiResources).toEqual([{ modelVersionId: 0, type: 'model' }]);
  });

  it('parses metadata with triple-dot before Negative prompt and dot before Steps', () => {
    const rawMetadata = `Parameters                      : A generic prompt text...Negative prompt: .Steps: 4, Sampler: Euler, CFG scale: 1.0, Seed: 521842852, Size: 1024x1024, Tool: ComfyUI, Technique: txt2img, Model: generic_model_v2, Version: ComfyUI, Civitai resources: [{"modelName":"Generic Model","versionName":"v2","air":"urn:air:flux2:checkpoint:civitai:12345@67890"},{"modelName":"Generic Lora","versionName":"v1.0","weight":1.0,"air":"urn:air:flux2:lora:civitai:11111@22222"}]`;
    const exif = { generationDetails: rawMetadata, parameters: rawMetadata };

    expect(automaticMetadataProcessor.canParse(exif)).toBe(true);

    const result = automaticMetadataProcessor.parse(exif);
    expect(result.prompt).toBe('A generic prompt text');
    expect(result.negativePrompt).toBe('');
    expect(result.steps).toBe('4');
    expect(result.sampler).toBe('Euler');
    expect(result.cfgScale).toBe('1.0');
    expect(result.seed).toBe('521842852');
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(result.Model).toBe('generic_model_v2');
    expect(result.civitaiResources).toEqual([
      { modelVersionId: 0, type: 'model' },
      { modelVersionId: 0, type: 'model', weight: 1.0 },
    ]);
  });

  it('does not split the "Hires steps" parameter onto its own line', () => {
    const rawMetadata = `masterpiece, best quality, 1girl
Negative prompt: bad quality, worst quality
Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, Size: 512x768, Denoising strength: 0.4, Hires upscale: 2, Hires steps: 15, Hires upscaler: Latent`;
    const exif = { generationDetails: rawMetadata, parameters: rawMetadata };

    expect(automaticMetadataProcessor.canParse(exif)).toBe(true);

    const result = automaticMetadataProcessor.parse(exif);
    expect(result.prompt).toBe('masterpiece, best quality, 1girl');
    // "Hires steps: 15" must not leak into the negative prompt as a second Steps line
    expect(result.negativePrompt).toBe('bad quality, worst quality');
    expect(result.steps).toBe('30');
    expect(result.seed).toBe('12345');
    expect(result['Hires steps']).toBe('15');
    expect(result['Hires upscaler']).toBe('Latent');
  });

  it('does not split a "steps:" that appears inside the prompt of already-structured metadata', () => {
    const rawMetadata = `tutorial diagram, steps: 1 2 3, colorful
Negative prompt: ugly
Steps: 25, Sampler: Euler, CFG scale: 7`;
    const exif = { generationDetails: rawMetadata, parameters: rawMetadata };

    expect(automaticMetadataProcessor.canParse(exif)).toBe(true);

    const result = automaticMetadataProcessor.parse(exif);
    expect(result.prompt).toBe('tutorial diagram, steps: 1 2 3, colorful');
    expect(result.negativePrompt).toBe('ugly');
    expect(result.steps).toBe('25');
    expect(result.sampler).toBe('Euler');
  });

  it('normalizes a long delimiter run in linear time (no catastrophic backtracking)', () => {
    // The delimiter run must NOT terminate in the keyword the regex is scanning for —
    // otherwise the match succeeds immediately and even the old unbounded regex is fast.
    // Here the run is followed by "Steps: 5" (so canParse's `Steps: ` gate passes and the
    // guard does not bail, since Steps is inline), which means the "Negative prompt:" pass
    // scans the entire run fruitlessly — the true catastrophic-backtracking case
    // (~9s on the unbounded regex at this size).
    const rawMetadata = `x${', '.repeat(50000)}Steps: 5`;
    const exif = { generationDetails: rawMetadata, parameters: rawMetadata };

    const start = Date.now();
    automaticMetadataProcessor.canParse(exif);
    const result = automaticMetadataProcessor.parse(exif);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.steps).toBe('5');
  });
});

describe('comfyMetadataProcessor - resource names supplied via node links', () => {
  // Real failing workflow from the "Image upload fails to parse metadata" ticket: the
  // CheckpointLoaderSimple's ckpt_name is a link to a CivitaiModelSelector node rather than a
  // literal string. Before the fix this threw "TypeError: e.startsWith is not a function" at the
  // AIR filter and the AIR never populated.
  const civitaiSelectorPrompt = {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 996478046243637,
        steps: 20,
        cfg: 8,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ['17', 1] } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: {
        text: 'beautiful scenery nature glass bottle landscape, purple galaxy bottle,',
        clip: ['4', 1],
      },
    },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'text, watermark', clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '17': {
      class_type: 'CivitaiModelSelector',
      inputs: {
        air: 'urn:air:sd1:checkpoint:civitai:43331@176425',
        resources_json:
          '{"bySlot":{"1":"urn:air:sd1:checkpoint:civitai:43331@176425"},"all":["urn:air:sd1:checkpoint:civitai:43331@176425"]}',
        '🔍 Browse Civitai': null,
      },
    },
  };

  it('resolves the AIR from a CivitaiModelSelector link and populates resources', () => {
    const exif = { prompt: JSON.stringify(civitaiSelectorPrompt), workflow: '{}' };

    expect(comfyMetadataProcessor.canParse(exif)).toBe(true);
    const result = comfyMetadataProcessor.parse(exif);

    expect(result.models).toEqual(['urn:air:sd1:checkpoint:civitai:43331@176425']);
    expect(result.civitaiResources).toHaveLength(1);
    expect(result.prompt).toContain('purple galaxy bottle');
  });

  it('resolves each loader to its own slot on a multi-resource selector', () => {
    const ckptAir = 'urn:air:sd1:checkpoint:civitai:43331@176425';
    const upscalerAir = 'urn:air:other:upscaler:civitai:147759@164821';
    // One CivitaiModelSelector feeds two loaders from different output slots. The resolver must
    // honor the output slot (value[1]) — grabbing the node's primary `air` would give both
    // loaders the checkpoint. (models/upscalers hold the raw AIR string, so this is independent
    // of @civitai/client's Air.parse, which is stubbed under vitest.)
    const prompt = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ['20', 1] } },
      '10': { class_type: 'UpscaleModelLoader', inputs: { model_name: ['20', 2] } },
      '20': {
        class_type: 'CivitaiModelSelector',
        inputs: {
          air: ckptAir,
          resources_json: JSON.stringify({
            bySlot: { '1': ckptAir, '2': upscalerAir },
            all: [ckptAir, upscalerAir],
          }),
        },
      },
    };
    const exif = { prompt: JSON.stringify(prompt), workflow: '{}' };

    const result = comfyMetadataProcessor.parse(exif);

    expect(result.models).toEqual([ckptAir]);
    expect(result.upscalers).toEqual([upscalerAir]);
  });

  it('captures a non-AIR name from a primitive link but does not surface it as a resource', () => {
    // Name routed through a primitive node — a plain filename, not an AIR. We still want to
    // capture it (in `models`), we just can't surface it as a recognizable civitaiResource.
    const prompt = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ['9', 0] } },
      '9': { class_type: 'PrimitiveNode', inputs: { value: 'coolmodel.safetensors' } },
    };
    const exif = { prompt: JSON.stringify(prompt), workflow: '{}' };

    const result = comfyMetadataProcessor.parse(exif);
    expect(result.models).toEqual(['coolmodel.safetensors']);
    expect(result.civitaiResources ?? []).toEqual([]);
  });

  it('skips a linked name with no resolvable string without throwing', () => {
    const prompt = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ['2', 0] } },
      // upstream node exposes no string name (e.g. it outputs a MODEL, not a filename/AIR)
      '2': { class_type: 'SomeModelPatcher', inputs: { model: ['1', 0], multiplier: 1 } },
    };
    const exif = { prompt: JSON.stringify(prompt), workflow: '{}' };

    const result = comfyMetadataProcessor.parse(exif);
    expect(result.models ?? []).toEqual([]);
  });
});
