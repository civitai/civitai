import { describe, it, expect } from 'vitest';
import { ExifParser } from '~/utils/metadata';
import { automaticMetadataProcessor } from '~/utils/metadata/automatic.metadata';

// TODO - create a suite of tests that uses images from civitai to test the different metadata parsers

const testImageUrl =
  'https://orchestration-new.civitai.com/v2/consumer/blobs/E8S6FBPH50ENNVF2PD5XRBPXB0.jpeg?sig=CfDJ8N_qP_UguotCoWxV0GDJyrqO3glAlXP7D6Hb6iXbU9BAZ6no3Pzo0PfuPoI42wFTr-BalGCgmLC5CRJMpYU8Rpi_QqslJAMyMrcmNmeutDpUiZ-C8oAhuumEznFYdbOq3d1hQK4mW0qylzz7qmpPnTxZfJ67zOPQUvskp1Fwv_Xoh_1wKej0bllrUzLdAgpnOVnrb9LTQC8yjeYn2SRQPOFx5pYwna3qVSIXh1Oz-TN7yISHZEncedPwDrwyN91iwRqWujthjJHfyJ_ziykqJCdXmyi5mzp1fp5pzRTRjWOx&exp=2027-02-26T17:34:23.6860202Z';

// The actual generationDetails string extracted from the test image.
// The Civitai metadata contains nested objects (aspectRatio, resources array).
const realGenerationDetails = `an ancient warrior princess with sad face, from the side, looking up, in rain, a small stream of water running down over her face, high contrast shadowing,
 candid style. high contrast, grain effect prominent throughout image, high contrast lighting creating dramatic shadows, grainy film-like texture, nipples
Negative prompt: photo , photography, bad quality, bad anatomy, worst quality, low quality, low resolution, extra fingers, blur, blurry, ugly, wrong proportions, watermark, image artifacts, lowres, ugly, jpeg artifacts, deformed, noisy image
Steps: 40, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 2027225909, Size: 1216x832, Clip skip: 2, Created Date: 2026-02-25T22:09:08.8166925Z, Civitai resources: [{"type":"checkpoint","modelVersionId":1714314,"modelName":"Plant Milk \\uD83C\\uDF3F - Model Suite","modelVersionName":"Hemp II"}], Civitai metadata: {"workflow":"txt2img","output":"image","input":"text","priority":"low","outputFormat":"jpeg","ecosystem":"Illustrious","quantity":4,"aspectRatio":{"value":"3:2","width":1216,"height":832},"negativePrompt":"photo , photography, bad quality, bad anatomy, worst quality, low quality, low resolution, extra fingers, blur, blurry, ugly, wrong proportions, watermark, image artifacts, lowres, ugly, jpeg artifacts, deformed, noisy image","sampler":"DPM++ 2M Karras","cfgScale":7,"steps":40,"clipSkip":2,"seed":2027225909,"enhancedCompatibility":false,"prompt":"an ancient warrior princess with sad face, from the side, looking up, in rain, a small stream of water running down over her face, high contrast shadowing,\\n candid style. high contrast, grain effect prominent throughout image, high contrast lighting creating dramatic shadows, grainy film-like texture, nipples","resources":[{"modelVersionId":1714314,"strength":1,"type":"Checkpoint"}]}`;

describe('ExifParser - test image URL', () => {
  it('should parse metadata from the test image without error', async () => {
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
    expect(result['Size']).toBe('512x512');
    // Civitai metadata should be fully removed from details line, not leaking into other fields
    expect(result['Civitai metadata']).toBeUndefined();
  });
});
