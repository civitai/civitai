import { describe, expect, it } from 'vitest';
import { MODEL_CARDS, cardByType, cardsForMedia } from '$lib/data/trainingModels';
import {
  MAX_SAMPLE_PROMPTS,
  addSamplePrompt,
  buildTrainingRuns,
  captionTriggerHit,
  compareFileNames,
  defaultRunParams,
  newRun,
  nextImgId,
  optimizerLrParams,
  paramDeviations,
  promptHasTrigger,
  runExtraCapabilities,
  sampleImagesProblem,
  seedPrompts,
  startLabelPass,
  withTrigger,
  versionOptions,
  CUSTOM_VERSION_KEY,
  type Img,
  type Run,
  type SamplePrompt,
} from './trainingFlow';

const rows = (texts: string[]): SamplePrompt[] => texts.map((text, id) => ({ id, text }));

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

describe('default version', () => {
  it('trains MOSS Image on Base by default (OpenMOSS: SFT to generate, Base to train)', () => {
    expect(run('mossimage').versionKey).toBe('mossimage_base');
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

  it('recommends shuffling with the trigger kept first once a trigger word is set', () => {
    expect(defaultRunParams(run('sdxl'))).toMatchObject({ shuffleTokens: false, keepTokens: '0' });
    expect(defaultRunParams(run('sdxl'), 'mychar')).toMatchObject({
      shuffleTokens: true,
      keepTokens: '1',
    });
    expect(defaultRunParams(run('sdxl'), '  ')).toMatchObject({ shuffleTokens: false });
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

  it('measures against the trigger-aware recommendation', () => {
    const r = run('sdxl');
    expect(paramDeviations(r, defaultRunParams(r, 'mychar'), 'tag', 'mychar')).toEqual([]);
    expect(paramDeviations(r, defaultRunParams(r), 'tag', 'mychar').map((d) => d.field)).toEqual([
      'shuffleTokens',
      'keepTokens',
    ]);
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
      rows(['ohwx, a photo']),
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

describe('sample prompts', () => {
  it('adds an empty row, never example text that would be submitted as a prompt', () => {
    const next = addSamplePrompt([
      { id: 0, text: 'ohwx, a photo' },
      { id: 4, text: 'ohwx, at the beach' },
    ]);
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ id: 5, text: '' });
  });

  it('stops adding at the cap', () => {
    const full = Array.from({ length: MAX_SAMPLE_PROMPTS }, (_, id) => ({ id, text: `p${id}` }));
    expect(addSamplePrompt(full)).toBe(full);
  });

  const submitWith = (prompts: string[]) => {
    const r = run('sdxl');
    return buildTrainingRuns(
      { media: 'image', loraType: 'character', runs: [r] },
      [image(1, ['ohwx', '1girl'])],
      'ohwx',
      'test',
      [{ run: r, params: defaultRunParams(r) }],
      rows(prompts),
      ['blue'],
      'tag'
    )[0]!.prompts;
  };

  it('submits trimmed prompts and drops blank rows', () => {
    expect(submitWith(['ohwx, a photo', '', '   ', '  ohwx, at the beach '])).toEqual([
      'ohwx, a photo',
      'ohwx, at the beach',
    ]);
  });

  it('never submits an empty prompt list when every row is blank', () => {
    expect(submitWith(['', '  '])).toEqual(['', '  ']);
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

describe('auto-label pass', () => {
  it('keys each target uniquely and marks it tried at submit, even when tile ids collide', () => {
    const a = { ...image(7, []), blobUrl: 'https://x/a.png' };
    const b = { ...image(7, []), blobUrl: 'https://x/b.png' };
    const { byKey, items } = startLabelPass([a, b]);
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
    expect(items.map((i) => byKey.get(i.key))).toEqual([a, b]);
    expect(items.map((i) => i.mediaUrl)).toEqual([a.blobUrl, b.blobUrl]);
    for (const t of [a, b]) expect(t).toMatchObject({ labeling: true, labelTried: true });
  });
});

describe('compareFileNames', () => {
  it('orders like a file browser: numeric runs by value, case-insensitive, folders grouped', () => {
    const names = ['clip10.mp4', 'Clip2.mp4', 'b/a.mp4', 'clip1.mp4', 'a/z.mp4', 'clip2.txt'];
    expect([...names].sort(compareFileNames)).toEqual([
      'a/z.mp4',
      'b/a.mp4',
      'clip1.mp4',
      'Clip2.mp4',
      'clip2.txt',
      'clip10.mp4',
    ]);
  });
});

describe('Custom base version', () => {
  // The orchestrator trains on a pasted base only for these cards' ecosystems; every other card
  // would silently train (and charge) on its official base.
  const CUSTOM_CARDS = ['anima', 'illustrious', 'pony', 'sd15', 'sdxl'];

  it('is offered on exactly the cards whose ecosystem honours a custom base', () => {
    const offered = MODEL_CARDS.filter((card) =>
      versionOptions(card).some((v) => v.key === CUSTOM_VERSION_KEY)
    ).map((card) => card.type);
    expect(offered.sort()).toEqual(CUSTOM_CARDS);
  });
});

describe('retired cards', () => {
  it('offers no Hunyuan card, and the Wan card keeps both versions', () => {
    const video = cardsForMedia('video', new Set());
    expect(video.map((c) => c.type)).not.toContain('hunyuan');
    const wan = video.find((c) => c.type === 'wan');
    expect(wan?.versions.map((v) => v.modelVariant)).toEqual(['2.2', '2.1']);
  });

  it('still resolves a past Hunyuan run to its card', () => {
    expect(cardByType('hunyuan')?.name).toBe('Hunyuan');
  });
});

describe('sample input images', () => {
  const img = (name: string) => ({ url: `https://orch.example/blobs/${name}`, name });
  const prompts = (...entries: [string, string?][]): SamplePrompt[] =>
    entries.map(([text, image], id) => ({ id, text, ...(image ? { image: img(image) } : {}) }));

  const submit = (cardTypes: string[], sample: SamplePrompt[]) => {
    const runs = cardTypes.map((t) => run(t));
    return buildTrainingRuns(
      { media: 'image', loraType: 'concept', runs },
      [image(1, [], 'ohwx, a photo')],
      'ohwx',
      'test',
      runs.map((r) => ({ run: r, params: defaultRunParams(r) })),
      sample,
      ['blue'],
      'caption'
    );
  };

  it('pairs each submitted prompt with its own image, skipping blank rows', () => {
    const [out] = submit(
      ['flux2klein'],
      prompts(['ohwx, make it night', 'a.png'], ['  '], ['ohwx, add snow', 'b.png'])
    );
    expect(out!.prompts).toEqual(['ohwx, make it night', 'ohwx, add snow']);
    expect(out!.sourceImages).toEqual([img('a.png').url, img('b.png').url]);
  });

  it('keeps a sweep run whose model takes no images text-only', () => {
    const [klein, sdxl] = submit(['flux2klein', 'sdxl'], prompts(['ohwx, make it night', 'a.png']));
    expect(klein!.sourceImages).toEqual([img('a.png').url]);
    expect(sdxl!.sourceImages).toBeUndefined();
    expect(sdxl!.prompts).toEqual(['ohwx, make it night']);
  });

  it('sends no images when no row has one', () => {
    expect(submit(['flux2klein'], prompts(['ohwx, a photo']))[0]!.sourceImages).toBeUndefined();
  });

  it('refuses a half-imaged list rather than submitting it text-only', () => {
    const half = prompts(['ohwx, make it night', 'a.png'], ['ohwx, add snow']);
    expect(sampleImagesProblem(half)).toMatch(/every sample prompt/);
    expect(() => submit(['flux2klein'], half)).toThrow(/every sample prompt/);
  });

  it('flags an image on a row with no prompt, which would be dropped with the row', () => {
    expect(sampleImagesProblem(prompts(['ohwx, make it night', 'a.png'], ['', 'b.png']))).toMatch(
      /needs a prompt/
    );
  });

  it('has nothing to flag when every prompt or none has an image', () => {
    expect(sampleImagesProblem(prompts(['a', 'a.png'], ['b', 'b.png'], ['']))).toBeNull();
    expect(sampleImagesProblem(prompts(['a'], ['b']))).toBeNull();
  });
});

describe('optimizer learning-rate coupling', () => {
  it('puts both rates at 1 when Prodigy is picked', () => {
    const r = run('sdxl');
    const params = { ...defaultRunParams(r), optimizer: 'Prodigy' };
    expect(optimizerLrParams(r, params)).toEqual({ unetLr: '1', textEncoderLr: '1' });
  });

  it('leaves a locked text-encoder rate at 0 under Prodigy', () => {
    const krea = run('krea2');
    const params = { ...defaultRunParams(krea), optimizer: 'Prodigy' };
    expect(optimizerLrParams(krea, params)).toMatchObject({ unetLr: '1' });
    expect(Number(optimizerLrParams(krea, params).textEncoderLr)).toBe(0);
  });

  it('resets Prodigy-level rates to the model defaults when switching away', () => {
    const r = run('sdxl');
    const d = defaultRunParams(r);
    const params = { ...d, optimizer: 'AdamW8Bit', unetLr: '1', textEncoderLr: '1' };
    expect(optimizerLrParams(r, params)).toEqual({
      unetLr: d.unetLr,
      textEncoderLr: d.textEncoderLr,
    });
  });

  it('keeps a rate the user picked below the Prodigy level', () => {
    const r = run('sdxl');
    const params = { ...defaultRunParams(r), optimizer: 'Adafactor', unetLr: '0.0002' };
    expect(optimizerLrParams(r, params).unetLr).toBe('0.0002');
  });
});
