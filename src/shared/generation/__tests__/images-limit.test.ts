import { describe, expect, it } from 'vitest';
import { ecosystems } from '~/shared/constants/basemodel.constants';
import { getWorkflowsForEcosystem } from '~/shared/generation/config/workflows';
import { getImagesLimit } from '../images-limit';

/**
 * Every ecosystem that answers `getImagesLimit` for at least one of its workflows, frozen by
 * name. The count assertion below catches a pair that stops answering; this catches it by
 * NAME, which is the difference between "something was lost" and knowing what.
 *
 * A new ecosystem does not belong here until it has an image-taking workflow — adding one
 * is additive and no assertion fails.
 */
const ECOSYSTEMS_WITH_A_LIMIT: string[] = [
  'Ace',
  'Anima',
  'AuraFlow',
  'Boogu',
  'Chroma',
  'CogVideoX',
  'Ernie',
  'Flux1',
  'Flux1Kontext',
  'Flux2',
  'Flux2Klein_4B',
  'Flux2Klein_4B_base',
  'Flux2Klein_9B',
  'Flux2Klein_9B_base',
  'Flux3',
  'Flux3Video',
  'FluxKrea',
  'Grok',
  'Haiper',
  'HappyHorse',
  'HiDream',
  'HiDream-O1',
  'Hunyuan3D',
  'HyDit1',
  'HyV1',
  'Ideogram',
  'Illustrious',
  'Imagen4',
  'Kling',
  'Kolors',
  'Krea2',
  'LTXV',
  'LTXV2',
  'LTXV23',
  'LTXV25',
  'Lens',
  'Lightricks',
  'Lumina',
  'MAI',
  'MageFlow',
  'Ming',
  'MingLayer',
  'MiniMaxH3',
  'MiniMaxMusic3',
  'Mochi',
  'MuseImage',
  'NanoBanana',
  'NoobAI',
  'ODOR',
  'OpenAI',
  'Other',
  'PixArtA',
  'PixArtE',
  'Pixal3D',
  'PlaygroundV2',
  'PolyGen',
  'Pony',
  'PonyV7',
  'Qwen',
  'Qwen2',
  'Qwen21',
  'Qwen3',
  'Reve',
  'SCascade',
  'SD1',
  'SD2',
  'SD3',
  'SD3_5M',
  'SDXL',
  'SDXLDistilled',
  'SVD',
  'Seedance',
  'Seedream',
  'Sonilo',
  'Sora2',
  'Trellis2',
  'Tripo',
  'Upscaler',
  'Veo3',
  'Vidu',
  'WanImage27',
  'WanVideo',
  'WanVideo-22-I2V-A14B',
  'WanVideo-22-T2V-A14B',
  'WanVideo-22-TI2V-5B',
  'WanVideo-25-I2V',
  'WanVideo-25-T2V',
  'WanVideo14B_I2V_480p',
  'WanVideo14B_I2V_720p',
  'WanVideo14B_T2V',
  'WanVideo1_3B_T2V',
  'WanVideo27',
  'WanVideo30',
  'YuE2',
  'ZImageBase',
  'ZImageTurbo',
];

/**
 * `getImagesLimit` is a PROBE, not a table — it instantiates the hub for an
 * (ecosystem, workflow) pin and reads the `images` field's meta. So its answers can
 * change without anyone editing a limit: a change to `probeFieldMeta`'s pin guard
 * moves them wholesale.
 *
 * The table below is the regression net: every pair whose answer is NOT the
 * `{min:1,max:1}` majority. A limit that changes deliberately changes a line here,
 * which is the review such a change deserves.
 */
const NON_DEFAULT_LIMITS: Array<[string, string, number, number]> = [
  ['Ace', 'txt2music', 0, 1],
  ['Flux2', 'img2img:edit', 1, 7],
  ['Flux2Klein_4B_base', 'img2img:edit', 1, 7],
  ['Flux2Klein_4B', 'img2img:edit', 1, 7],
  ['Flux2Klein_9B_base', 'img2img:edit', 1, 7],
  ['Flux2Klein_9B', 'img2img:edit', 1, 7],
  ['Flux3', 'img2img:edit', 1, 10],
  ['Flux3Video', 'img2vid', 1, 2],
  ['Flux3Video', 'img2vid:first-last', 1, 2],
  ['Grok', 'img2img:edit', 1, 7],
  ['Grok', 'img2vid:ref2vid', 1, 7],
  ['HappyHorse', 'img2vid:ref2vid', 1, 9],
  ['HappyHorse', 'vid2vid:edit', 1, 9],
  ['HiDream-O1', 'img2img:edit', 1, 4],
  ['Ideogram', 'img2img:edit', 1, 4],
  ['Kling', 'img2vid:ref2vid', 1, 7],
  ['Krea2', 'img2img:edit', 1, 4],
  ['LTXV2', 'img2vid', 1, 2],
  ['LTXV2', 'img2vid:first-last', 1, 2],
  ['LTXV23', 'img2vid', 1, 2],
  ['LTXV23', 'img2vid:first-last', 1, 2],
  ['LTXV25', 'img2vid', 1, 2],
  ['LTXV25', 'img2vid:first-last', 1, 2],
  ['MageFlow', 'img2img:edit', 1, 3],
  ['Ming', 'img2img:edit', 1, 3],
  ['MiniMaxH3', 'img2vid', 1, 2],
  ['MiniMaxH3', 'img2vid:first-last', 1, 2],
  ['MiniMaxH3', 'img2vid:ref2vid', 1, 9],
  ['MuseImage', 'img2img:edit', 1, 4],
  ['NanoBanana', 'img2img:edit', 1, 7],
  ['OpenAI', 'img2img:edit', 1, 7],
  ['Qwen', 'img2img:edit', 1, 3],
  ['Qwen2', 'img2img:edit', 1, 3],
  ['Qwen21', 'img2img:edit', 1, 10],
  ['Qwen3', 'img2img:edit', 1, 3],
  ['Reve', 'img2img:edit', 1, 4],
  ['Seedance', 'img2vid:ref2vid', 1, 9],
  ['Seedream', 'img2img:edit', 1, 7],
  ['Upscaler', 'img2img:upscale', 1, 10],
  ['Veo3', 'img2vid:ref2vid', 1, 3],
  ['Vidu', 'img2vid', 1, 2],
  ['Vidu', 'img2vid:first-last', 1, 2],
  ['Vidu', 'img2vid:ref2vid', 1, 7],
  ['WanImage27', 'img2img:edit', 1, 5],
  ['WanVideo27', 'img2vid', 1, 2],
  ['WanVideo27', 'img2vid:first-last', 1, 2],
  ['WanVideo27', 'img2vid:ref2vid', 1, 5],
  ['WanVideo30', 'img2vid', 1, 2],
  ['WanVideo30', 'img2vid:first-last', 1, 2],
];

describe('getImagesLimit', () => {
  const pairs: Array<[string, string]> = [];
  for (const eco of ecosystems) {
    for (const w of getWorkflowsForEcosystem(eco.id)) pairs.push([eco.key, w.graphKey]);
  }

  it('walks a meaningful number of pairs', () => {
    expect(pairs.length).toBeGreaterThan(200);
  });

  it.each(NON_DEFAULT_LIMITS)('%s/%s accepts %i to %i images', (eco, workflow, min, max) => {
    expect(getImagesLimit(eco, workflow)).toEqual({ min, max });
  });

  // The complement of the table: a pair that gains or loses a limit, or drifts off the
  // 1-image default, lands here. App Blocks fails CLOSED on undefined, so a probe that
  // returned undefined everywhere would satisfy the table above by vacuous `it.each`
  // rows alone — the count assertion is what stops that.
  it('answers {min:1,max:1} for every OTHER pair that has a limit at all', () => {
    const tabled = new Set(NON_DEFAULT_LIMITS.map(([e, w]) => `${e}/${w}`));
    const unexpected: string[] = [];
    let withLimit = 0;
    for (const [ecosystem, workflow] of pairs) {
      const limit = getImagesLimit(ecosystem, workflow);
      if (!limit) continue;
      withLimit++;
      if (tabled.has(`${ecosystem}/${workflow}`)) continue;
      if (limit.min !== 1 || limit.max !== 1)
        unexpected.push(`${ecosystem}/${workflow}: ${JSON.stringify(limit)}`);
    }
    expect(unexpected).toEqual([]);

    // Directional, not a loose floor. An ecosystem launch only ADDS pairs, so a count that
    // went down means a pair stopped answering — and App Blocks fails closed on
    // `undefined`, so each one is "App Blocks refuses a source image the form accepts".
    // `toBeGreaterThan(250)` left 32 pairs of headroom for that to happen in silently,
    // and the loop above cannot catch it either: it `continue`s on a missing limit before
    // counting, so a lost pair is absent from `unexpected` rather than named in it.
    expect(
      withLimit,
      'fewer pairs answer than before — a limit was lost, not added'
    ).toBeGreaterThanOrEqual(282);

    // Which ecosystems answer at all is frozen by name, so losing one reads as its own
    // key rather than as an arithmetic drop.
    const answering = new Set(pairs.filter(([e, w]) => getImagesLimit(e, w)).map(([e]) => e));
    expect(
      ECOSYSTEMS_WITH_A_LIMIT.filter((e) => !answering.has(e)),
      'these ecosystems answered with an images limit and no longer do'
    ).toEqual([]);
  });

  // The probe answers for the route the engine really takes, which is NOT always the pin
  // it was handed: these five reach a sibling route (a Wan T2V build on img2vid, Kling's
  // first-last) by keeping the stated ecosystem and correcting the model. An over-strict
  // pin guard reports "cannot determine" for them, and App Blocks then refuses a source
  // image the form accepts.
  it.each([
    ['WanVideo14B_T2V', 'img2vid'],
    ['WanVideo14B_I2V_720p', 'img2vid'],
    ['WanVideo-22-T2V-A14B', 'img2vid'],
    ['WanVideo-25-T2V', 'img2vid'],
    ['Kling', 'img2vid:first-last'],
  ])('answers for the sibling route %s/%s resolves to', (ecosystem, workflow) => {
    expect(getImagesLimit(ecosystem, workflow)).toEqual({ min: 1, max: 1 });
  });
});
