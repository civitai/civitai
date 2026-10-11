import { describe, expect, it } from 'vitest';
import { cardByType } from '$lib/data/trainingModels';
import {
  buildTrainingRuns,
  captionTriggerHit,
  defaultRunParams,
  newRun,
  nextImgId,
  paramDeviations,
  promptHasTrigger,
  runExtraCapabilities,
  seedPrompts,
  withTrigger,
  type Img,
  type Run,
} from './trainingFlow';

const run = (cardType: string, versionKey?: string): Run => {
  const card = cardByType(cardType);
  if (!card) throw new Error(`no card ${cardType}`);
  const r = newRun(card);
  return versionKey ? { ...r, versionKey } : r;
};

const image = (id: number, tags: string[], caption = ''): Img => ({
  id,
  name: `${id}.png`,
  previewUrl: '',
  mediaType: 'image',
  status: 'uploaded',
  progress: 1,
  blobId: `blob-${id}`,
  tags,
  caption,
});

describe('trigger words in sample prompts', () => {
  it('leads every seeded prompt with the trigger, without duplicating an existing one', () => {
    const prompts = seedPrompts(
      ['1girl, outdoors', 'OHWX_person, portrait', 'a cat'],
      'ohwx_person'
    );
    expect(prompts).toHaveLength(3);
    for (const p of prompts) expect(promptHasTrigger('ohwx_person', p.text)).toBe(true);
    const kept = prompts.find((p) => p.text.includes('portrait'))!;
    expect(kept.text).toBe('OHWX_person, portrait');
    expect(kept.text.toLowerCase().split('ohwx_person')).toHaveLength(2);
  });

  it('falls back to a triggered generic prompt for an unlabeled dataset', () => {
    expect(seedPrompts([], 'ohwx').map((p) => p.text)).toEqual(['ohwx, a photo']);
    expect(seedPrompts([], '').map((p) => p.text)).toEqual(['a photo']);
  });

  it('never warns when there is no trigger, and matches case-insensitively when there is', () => {
    expect(promptHasTrigger('', 'anything')).toBe(true);
    expect(promptHasTrigger('  ', 'anything')).toBe(true);
    expect(promptHasTrigger('ohwx', 'a photo of OHWX smiling')).toBe(true);
    expect(promptHasTrigger('ohwx', 'a photo')).toBe(false);
    expect(promptHasTrigger('art', 'a portrait, studio lighting')).toBe(false);
    expect(promptHasTrigger('art', 'art, a portrait')).toBe(true);
    expect(promptHasTrigger('ohwx person', 'OHWX person, smiling')).toBe(true);
    expect(promptHasTrigger('c++', 'code in c++, terminal')).toBe(true);
    // The caption highlight and the prompt check share one matcher, so they can't disagree.
    expect(captionTriggerHit('art', 'portrait of a woman')).toBeNull();
    expect(captionTriggerHit('art', 'Art, portrait')).toEqual({
      before: '',
      match: 'Art',
      after: ', portrait',
    });
    expect(withTrigger('ohwx', 'a photo')).toBe('ohwx, a photo');
    expect(withTrigger('ohwx', '')).toBe('ohwx');
    expect(withTrigger('ohwx', 'Ohwx, a photo')).toBe('Ohwx, a photo');
  });
});

describe('extra parameter capabilities', () => {
  it('offers everything to an SDXL tag dataset', () => {
    const caps = runExtraCapabilities(run('sdxl'), 'tag');
    for (const cap of Object.values(caps)) expect(cap.supported).toBe(true);
  });

  it('withholds tag-only and SD-only fields from a caption model, with a reason', () => {
    const caps = runExtraCapabilities(run('zimage'), 'caption');
    expect(caps.shuffleTokens.supported).toBe(false);
    expect(caps.keepTokens.supported).toBe(false);
    expect(caps.minSnrGamma.supported).toBe(false);
    expect(caps.minSnrGamma.reason).toMatch(/SD 1\.5 and SDXL/);
    expect(caps.noiseOffset.supported).toBe(true);
    expect(caps.flipAugmentation.supported).toBe(true);
  });

  it('withholds image-only augmentation from video', () => {
    const caps = runExtraCapabilities(run('minimaxh3'), 'caption');
    expect(caps.noiseOffset.supported).toBe(false);
    expect(caps.flipAugmentation.supported).toBe(false);
    expect(caps.noiseOffset.reason).toMatch(/video/);
  });

  it('seeds noise offset as the main trainer does — on for SD/Flux/Chroma/Qwen, off for the rest', () => {
    expect(defaultRunParams(run('sdxl')).noiseOffset).toBe('0.1');
    expect(defaultRunParams(run('chroma')).noiseOffset).toBe('0.1');
    expect(defaultRunParams(run('zimage')).noiseOffset).toBe('0');
    expect(defaultRunParams(run('krea2')).noiseOffset).toBe('0');
  });
});

describe('paramDeviations', () => {
  it('is empty for untouched defaults and treats equal numbers as equal', () => {
    const r = run('sdxl');
    const params = defaultRunParams(r);
    expect(paramDeviations(r, params, 'tag')).toEqual([]);
    params.textEncoderLr = '0.00005';
    expect(paramDeviations(r, { ...params, textEncoderLr: '5e-5' }, 'tag')).toEqual([]);
  });

  it('names each changed field with its recommendation, in form order', () => {
    const r = run('sdxl');
    const params = { ...defaultRunParams(r), networkDim: '64', shuffleTokens: true, steps: 3000 };
    const devs = paramDeviations(r, params, 'tag');
    expect(devs.map((d) => d.field)).toEqual(['steps', 'networkDim', 'shuffleTokens']);
    expect(devs[1]).toMatchObject({ label: 'Network dim', value: '64', recommended: '32' });
    expect(devs[2]).toMatchObject({ label: 'Shuffle tags', value: 'On', recommended: 'Off' });
  });

  it('ignores fields the run cannot use — a locked TE rate, tag fields on captions', () => {
    const krea = run('krea2');
    expect(
      paramDeviations(krea, { ...defaultRunParams(krea), textEncoderLr: '0.001' }, 'caption')
    ).toEqual([]);
    const z = run('zimage');
    expect(
      paramDeviations(
        z,
        { ...defaultRunParams(z), shuffleTokens: true, keepTokens: '2' },
        'caption'
      )
    ).toEqual([]);
  });
});

describe('buildTrainingRuns extra fields', () => {
  const images = [image(1, ['ohwx', '1girl']), image(2, ['ohwx', 'solo'])];
  const build = (r: Run, labelMode: 'tag' | 'caption', overrides = {}) =>
    buildTrainingRuns(
      { media: 'image', loraType: 'character', runs: [r] },
      images,
      'ohwx',
      'test',
      [{ run: r, params: { ...defaultRunParams(r), ...overrides } }],
      ['ohwx, a photo'],
      ['blue'],
      labelMode
    )[0]!;

  it('sends the tag fields as set for a tag dataset on an SD-family model', () => {
    const out = build(run('sdxl'), 'tag', {
      shuffleTokens: true,
      keepTokens: '1',
      minSnrGamma: '3',
      flipAugmentation: true,
    });
    expect(out).toMatchObject({
      shuffleTokens: true,
      keepTokens: 1,
      minSnrGamma: 3,
      noiseOffset: 0.1,
      flipAugmentation: true,
    });
  });

  it('zeroes what the run cannot use, whatever the form holds', () => {
    const out = build(run('zimage'), 'caption', {
      shuffleTokens: true,
      keepTokens: '2',
      minSnrGamma: '7',
      noiseOffset: '0.2',
    });
    expect(out.shuffleTokens).toBe(false);
    expect(out.keepTokens).toBe(0);
    expect(out.minSnrGamma).toBeUndefined();
    expect(out.noiseOffset).toBe(0.2);
    const video = build(run('minimaxh3'), 'caption', {
      noiseOffset: '0.5',
      flipAugmentation: true,
    });
    expect(video.noiseOffset).toBe(0);
    expect(video.flipAugmentation).toBe(false);
  });
});

describe('nextImgId', () => {
  it('never re-issues an id across a Data step remount', () => {
    const first = Array.from({ length: 5 }, nextImgId);
    const second = Array.from({ length: 5 }, nextImgId);
    expect(new Set([...first, ...second]).size).toBe(10);
    expect(Math.min(...second)).toBeGreaterThan(Math.max(...first));
  });
});
