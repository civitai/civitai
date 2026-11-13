import { describe, expect, it } from 'vitest';
import { isTextEncoderLockedBase } from '@civitai/shared/training-text-encoder';
import { parseServiceStatus } from '$lib/service-status-core';
import {
  LORA_TYPES,
  MODEL_CARDS,
  PARAM_DEFAULTS,
  TE_LOCKED_ECOSYSTEMS,
  cardByType,
  catalogFlagKeys,
  cardsForMedia,
  editCards,
  visibleVersions,
  type ModelVersionInfo,
} from '$lib/data/trainingModels';
import {
  MAX_SAMPLE_PROMPTS,
  addSamplePrompt,
  buildTrainingRuns,
  stampMature,
  captionTriggerHit,
  compareFileNames,
  defaultRunParams,
  networkDimSizeHint,
  newRun,
  nextImgId,
  numberInputValue,
  optimizerLrParams,
  teLocked,
  paramDeviations,
  paramHelpText,
  promptHasTrigger,
  recommendedCardFor,
  runExtraCapabilities,
  sampleImagesProblem,
  seedPrompts,
  startLabelPass,
  autoLabelTargets,
  handLabelOnlyCount,
  labelTextAfterSwitch,
  matchesTagFilter,
  withFilterTags,
  withTags,
  withTrigger,
  versionOptions,
  CUSTOM_VERSION_KEY,
  type Img,
  type Run,
  type SamplePrompt,
  blockedSelectionMessage,
  cardUnavailability,
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
  it('gates convolution, caption dropout and warmup by model, engine and scheduler', () => {
    for (const type of ['sd15', 'sdxl', 'pony', 'illustrious']) {
      const r = run(type);
      expect(runExtraCapabilities(r, 'tag').trainConv.supported).toBe(true);
      expect(runExtraCapabilities(r, 'tag').lrWarmupSteps.supported).toBe(false);
    }
    expect(runExtraCapabilities(run('minimaxh3'), 'caption').trainConv.supported).toBe(false);
    expect(runExtraCapabilities(run('yue2'), 'caption').captionDropoutRate.supported).toBe(false);
    const flux = run('flux2');
    const caps = runExtraCapabilities(flux, 'caption');
    for (const field of [
      'lrWarmupSteps',
      'captionDropoutRate',
      'rankDropout',
      'trainConv',
    ] as const)
      expect(caps[field].supported).toBe(false);
  });

  it('offers all advanced controls to an SDXL tag dataset with constant learning rate', () => {
    const r = run('sdxl');
    const caps = runExtraCapabilities(r, 'tag', {
      ...defaultRunParams(r),
      lrScheduler: 'constant',
    });
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

  it('sizes an Anima network by LoRA type — 8 for characters, 16 otherwise, custom base too', () => {
    const size = (r: Run, loraType: string) => {
      const { networkDim, networkAlpha } = defaultRunParams(r, '', loraType);
      return [networkDim, networkAlpha];
    };
    for (const r of [run('anima'), run('anima', CUSTOM_VERSION_KEY)]) {
      expect(size(r, 'character')).toEqual(['8', '8']);
      expect(size(r, 'style')).toEqual(['16', '16']);
      expect(size(r, 'concept')).toEqual(['16', '16']);
    }
    expect(size(run('zimage'), 'character')).toEqual(['32', '32']);
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

  it("measures network size against the LoRA type's recommendation", () => {
    const r = run('anima');
    expect(
      paramDeviations(r, defaultRunParams(r, '', 'character'), 'tag', '', 'character')
    ).toEqual([]);
    const devs = paramDeviations(r, defaultRunParams(r, '', 'style'), 'tag', '', 'character');
    expect(devs.map((d) => [d.field, d.recommended])).toEqual([
      ['networkDim', '8'],
      ['networkAlpha', '8'],
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

  it('ignores fields the run cannot use — a locked TE rate, resolution, tag fields on captions', () => {
    const krea = run('krea2');
    expect(
      paramDeviations(krea, { ...defaultRunParams(krea), textEncoderLr: '0.001' }, 'caption')
    ).toEqual([]);
    const sdxl = run('sdxl');
    expect(paramDeviations(sdxl, { ...defaultRunParams(sdxl), resolution: '2048' }, 'tag')).toEqual(
      []
    );
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

  it('preserves backend defaults for blank new fields and sends explicit zeroes', () => {
    const defaults = build(run('sdxl'), 'tag', { lrScheduler: 'constant' });
    for (const field of ['lrWarmupSteps', 'captionDropoutRate', 'rankDropout'] as const)
      expect(defaults).not.toHaveProperty(field);
    expect(defaults.trainConv).toBe(false);
    const edited = build(run('sdxl'), 'tag', {
      lrScheduler: 'constant',
      lrWarmupSteps: '0',
      captionDropoutRate: '0',
      rankDropout: '0',
      trainConv: true,
    });
    expect(edited).toMatchObject({
      lrWarmupSteps: 0,
      captionDropoutRate: 0,
      rankDropout: 0,
      trainConv: true,
    });
  });

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

  it('sends the fallback, not 0, for a cleared numeric field', () => {
    const out = build(run('sdxl'), 'tag', { unetLr: '', networkDim: '  ' });
    const d = defaultRunParams(run('sdxl'));
    expect(out.unetLr).toBe(Number(d.unetLr));
    expect(out.networkDim).toBe(Number(d.networkDim));
    expect(out.unetLr).toBeGreaterThan(0);
  });

  it('falls back to the Prodigy rate for a cleared LR under Prodigy', () => {
    const out = build(run('sdxl'), 'tag', { optimizer: 'Prodigy', unetLr: '' });
    expect(out.unetLr).toBe(1);
  });
});

describe('numberInputValue', () => {
  // A blank field must read back as null, or Svelte clears a half-typed `1e` on the way to `1e-4`.
  it('reads a blank field as null and passes values through', () => {
    expect(numberInputValue('')).toBeNull();
    expect(numberInputValue(0.0001)).toBe(0.0001);
    expect(numberInputValue(0)).toBe(0);
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

describe('auto-label targets', () => {
  // A fresh upload carries the orchestrator's https URL; a Train again / Reuse a dataset tile carries
  // the object URL its preview hydrated to, which the submit refuses with a 400.
  const fresh = {
    ...image(1, []),
    blobUrl: 'https://orchestration.civitai.com/v2/consumer/blobs/a.jpeg?sig=1',
  };
  const reused = {
    ...image(2, []),
    blobUrl: 'blob:https://training.civitai.com/3f9a1c2e-7b1d-4e0a',
  };
  const reusedCaptioned = {
    ...image(3, [], 'a woman, portrait'),
    blobUrl: reused.blobUrl,
    labelTried: true,
  };
  const freshLabeled = { ...image(4, ['1girl']), blobUrl: fresh.blobUrl };
  const freshTried = { ...image(5, []), blobUrl: fresh.blobUrl, labelTried: true };
  const all = [fresh, reused, reusedCaptioned, freshLabeled, freshTried];

  it('sends fresh uploads and leaves reused tiles out of the drain and Label all', () => {
    const drain = autoLabelTargets(all, { skipLabeled: true, skipTried: true, focusId: null });
    const labelAll = autoLabelTargets(all, { skipLabeled: false, skipTried: false, focusId: null });
    expect(drain.map((i) => i.id)).toEqual([1]);
    expect(labelAll.map((i) => i.id)).toEqual([1, 4, 5]);
    expect(handLabelOnlyCount(all)).toBe(2);
  });

  it("a format-switch Re-label clears a fresh tile's text and keeps a reused tile's", () => {
    const freshCaptioned = { ...image(6, [], 'a man, outdoors'), blobUrl: fresh.blobUrl };
    expect(labelTextAfterSwitch(freshCaptioned, 'caption', 'relabel')).toBe('');
    expect(labelTextAfterSwitch(reusedCaptioned, 'caption', 'relabel')).toBe('a woman, portrait');
    expect(labelTextAfterSwitch(freshCaptioned, 'caption', 'convert')).toBe('a man, outdoors');
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

  it('offers no Ideogram 4 card to anyone, but still resolves past runs', () => {
    const everyFlag = new Set(MODEL_CARDS.flatMap((c) => (c.flagKey ? [c.flagKey] : [])));
    expect(cardsForMedia('image', everyFlag).map((c) => c.type)).not.toContain('ideogram4');
    expect(cardByType('ideogram4')?.name).toBe('Ideogram 4');
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
  it.each(['sdxl', 'sd15', 'ernie'])('puts both rates at 1 when Prodigy is picked (%s)', (type) => {
    const r = run(type);
    const params = { ...defaultRunParams(r), optimizer: 'Prodigy' };
    expect(optimizerLrParams(r, params)).toEqual({ unetLr: '1', textEncoderLr: '1' });
    expect(teLocked(r)).toBe(false);
  });

  // One per class the in-app trainer locks, the Klein edit cards included through their ecosystem.
  it.each([
    'flux',
    'flux2klein',
    'flux2klein-edit',
    'chroma',
    'qwen',
    'zimage',
    'hidream-o1',
    'anima',
    'boogu',
    'krea2',
    'mageflow',
    'ideogram4',
    'wan',
    'hunyuan',
    'ltx',
    'minimaxh3',
    'ming',
    'qwen21',
    'yue2',
    'acestep',
  ])('locks the text-encoder rate at 0, Prodigy included (%s)', (type) => {
    const r = run(type);
    // A stale nonzero rate (a saved run, a model switch) must not become 1.
    const params = { ...defaultRunParams(r), optimizer: 'Prodigy', textEncoderLr: '0.0001' };
    expect(teLocked(r)).toBe(true);
    expect(optimizerLrParams(r, params)).toEqual({ unetLr: '1', textEncoderLr: '0' });
  });

  it.each(['mossimage', 'flux3klein'])(
    'keeps a default-off text encoder off under Prodigy, but editable (%s)',
    (type) => {
      const r = run(type);
      const params = { ...defaultRunParams(r), optimizer: 'Prodigy' };
      expect(teLocked(r)).toBe(false);
      expect(optimizerLrParams(r, params)).toEqual({ unetLr: '1', textEncoderLr: '0' });
      expect(optimizerLrParams(r, { ...params, textEncoderLr: '0.0001' }).textEncoderLr).toBe('1');
    }
  );

  it('locks every version the in-app trainer locks', () => {
    const locked = MODEL_CARDS.flatMap((card) =>
      card.versions.filter((v) => isTextEncoderLockedBase(v.key)).map((v) => run(card.type, v.key))
    );
    expect(locked.length).toBeGreaterThan(20);
    for (const r of locked) expect(teLocked(r)).toBe(true);
  });

  // The server locks by ecosystem; one that mixed a locked version with a trainable one would lock both.
  it('locks no ecosystem that holds a version recommending a text encoder rate', () => {
    const trainable = MODEL_CARDS.flatMap((c) => c.versions).filter(
      (v) =>
        TE_LOCKED_ECOSYSTEMS.has(v.ecosystem) && (PARAM_DEFAULTS[v.key]?.textEncoderLr ?? 0) > 0
    );
    expect(trainable.map((v) => v.key)).toEqual([]);
  });

  it('leaves a text encoder the user turned off at 0 under Prodigy', () => {
    const r = run('sdxl');
    const params = { ...defaultRunParams(r), optimizer: 'Prodigy', textEncoderLr: '0' };
    expect(optimizerLrParams(r, params).textEncoderLr).toBe('0');
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

describe('network dim size hint', () => {
  it('names the file size for measured cards, which must still exist', () => {
    for (const type of ['sdxl', 'illustrious', 'pony', 'flux', 'sd15']) {
      expect(cardByType(type), type).toBeDefined();
      expect(networkDimSizeHint(type, 32), type).toMatch(/about \d+MB/);
    }
    expect(networkDimSizeHint('illustrious', 8)).toBe(
      ' At dim 8 the file is about 54MB (≈6.8MB per dim).'
    );
    expect(networkDimSizeHint('flux', 32)).toBe(
      ' At dim 32 the file is about 328MB (≈10.3MB per dim).'
    );
  });

  it('says nothing for unmeasured cards or a cleared field', () => {
    expect(networkDimSizeHint('wan', 32)).toBe('');
    expect(networkDimSizeHint('sdxl', '')).toBe('');
    expect(networkDimSizeHint('sdxl', 0)).toBe('');
    expect(networkDimSizeHint('sdxl', -8)).toBe('');
  });

  it('sizes the help text for the dim the user entered, not the recommended one', () => {
    const run = newRun(cardByType('sdxl')!);
    const defaults = defaultRunParams(run, '');
    const help = paramHelpText('networkDim', 'sdxl', defaults, { ...defaults, networkDim: 128 });
    expect(help).toContain('Recommended for this model: 32.');
    expect(help).toContain('At dim 128 the file is about 870MB');
    expect(paramHelpText('networkAlpha', 'sdxl', defaults, defaults)).not.toContain('MB');
  });
});

describe('stampMature', () => {
  const run = { meta: { name: 'a' }, currencies: ['blue'] } as unknown as Parameters<
    typeof stampMature
  >[0][number];

  it('puts one confirm and the mature count on every run of a sweep', () => {
    const out = stampMature([run, { ...run, meta: { name: 'b' } }], true, 3);
    expect(out.map((r) => [r.matureAck, r.meta.matureCount, r.meta.name])).toEqual([
      [true, 3, 'a'],
      [true, 3, 'b'],
    ]);
  });

  it('sends no confirm when the user gave none, but still stamps the count', () => {
    const [out] = stampMature([run], false, 2);
    expect('matureAck' in out!).toBe(false);
    expect(out!.meta.matureCount).toBe(2);
  });
});

describe('withTags', () => {
  it('appends a comma/newline paste in order, skipping tags the image already has', () => {
    expect(withTags(['red hair', 'smile'], 'smile, blue eyes\nred hair,  hat ')).toEqual([
      'red hair',
      'smile',
      'blue eyes',
      'hat',
    ]);
  });
  it('returns the same array when nothing new was typed, so an empty commit is not an edit', () => {
    const tags = ['smile'];
    expect(withTags(tags, ' , smile ')).toBe(tags);
  });
});

describe('matchesTagFilter', () => {
  const tags = ['1girl', 'dress', 'smile'];
  it('keeps an image with every included tag and none of the excluded ones', () => {
    expect(matchesTagFilter(tags, { include: ['dress'], exclude: ['crown'] })).toBe(true);
    expect(matchesTagFilter([...tags, 'crown'], { include: ['dress'], exclude: ['crown'] })).toBe(
      false
    );
    expect(matchesTagFilter(tags, { include: ['dress', 'crown'], exclude: [] })).toBe(false);
  });
  it('an exclude-only filter surfaces the images missing the tag, unlabeled ones included', () => {
    expect(matchesTagFilter(['1girl'], { include: [], exclude: ['dress'] })).toBe(true);
    expect(matchesTagFilter([], { include: [], exclude: ['dress'] })).toBe(true);
    expect(matchesTagFilter(tags, { include: [], exclude: ['dress'] })).toBe(false);
  });
  it("ignores case, so a typed tag finds the tagger's", () => {
    expect(matchesTagFilter(tags, { include: ['Dress'], exclude: [] })).toBe(true);
    expect(matchesTagFilter(tags, { include: [], exclude: ['SMILE'] })).toBe(false);
  });
});

describe('withFilterTags', () => {
  it('adds a comma paste to one side and moves a tag already on the other side', () => {
    expect(
      withFilterTags({ include: ['dress'], exclude: ['crown'] }, 'Crown, hat', 'include')
    ).toEqual({
      include: ['dress', 'Crown', 'hat'],
      exclude: [],
    });
    expect(withFilterTags({ include: ['dress'], exclude: [] }, 'dress', 'exclude')).toEqual({
      include: [],
      exclude: ['dress'],
    });
  });
  it('does not list a tag twice on the same side', () => {
    expect(withFilterTags({ include: ['dress'], exclude: [] }, 'DRESS', 'include')).toEqual({
      include: ['DRESS'],
      exclude: [],
    });
  });
});

describe('per-model flag gates', () => {
  const imageTypes = (flags: string[]) => cardsForMedia('image', new Set(flags)).map((c) => c.type);

  it('offers Krea 2 only to a viewer with krea2-training', () => {
    expect(imageTypes([])).not.toContain('krea2');
    expect(imageTypes(['krea2-training'])).toContain('krea2');
  });

  it('offers Z-Image Base to everyone and Turbo only behind its flag', () => {
    const zimage = cardByType('zimage')!;
    expect(versionOptions(zimage, new Set()).map((v) => v.key)).toEqual(['zimagebase']);
    expect(newRun(zimage, new Set()).versionKey).toBe('zimagebase');
    expect(imageTypes([])).toContain('zimage');
    expect(versionOptions(zimage, new Set(['zimage-turbo-training'])).map((v) => v.key)).toEqual([
      'zimageturbo',
      'zimagebase',
    ]);
  });

  it('offers Flux.2 to everyone', () => {
    expect(imageTypes([])).toContain('flux2');
  });

  it('offers LTX 2.0 to everyone and skips the gated 2.5/2.3 defaults', () => {
    const videoTypes = (flags: string[]) =>
      cardsForMedia('video', new Set(flags)).map((c) => c.type);
    expect(videoTypes([])).toContain('ltx');
    const ltx = cardByType('ltx')!;
    expect(versionOptions(ltx, new Set()).map((v) => v.key)).toEqual(['ltx2']);
    expect(newRun(ltx, new Set(['ltx23-training'])).versionKey).toBe('ltx23');
  });

  it('never offers Flux.2 Klein 9B without a Klein flag, on any card or recommendation', () => {
    const KLEIN_FLAGS = ['flux2-klein-training', 'flux2-klein-edit-training'];
    // Every other gate open: the most a non-Klein viewer could see.
    const flags = new Set(catalogFlagKeys().filter((k) => !KLEIN_FLAGS.includes(k)));
    const klein9bAir = cardByType('flux2klein')!.versions.find((v) => v.modelVariant === '9b')!.air;
    const isKlein9b = (v: ModelVersionInfo) => v.air === klein9bAir;
    const offered = (on: ReadonlySet<string>) =>
      [...cardsForMedia('image', on), ...cardsForMedia('video', on), ...editCards(on)]
        .flatMap((c) => visibleVersions(c, on))
        .filter(isKlein9b);

    expect(offered(flags)).toEqual([]);
    for (const t of LORA_TYPES)
      for (const media of ['image', 'video'] as const) {
        const card = recommendedCardFor(t.id, media, flags);
        expect(visibleVersions(card, flags).some(isKlein9b)).toBe(false);
      }
    // Either Klein flag alone exposes 9B, so the check above can fail.
    for (const k of KLEIN_FLAGS) expect(offered(new Set([...flags, k])).length).toBeGreaterThan(0);
  });
});

describe('newRun on a card with no version open to the viewer', () => {
  it('refuses rather than seed a gated version', () => {
    const zimage = cardByType('zimage')!;
    const turboOnly = { ...zimage, versions: zimage.versions.filter((v) => v.flagKey) };
    expect(() => newRun(turboOnly, new Set())).toThrow();
  });
});

describe('a model that is down', () => {
  const krea2 = cardByType('krea2')!;
  const blocked = parseServiceStatus({
    blockedModels: [krea2.versions[0]!.key],
    blockedModelReasons: { [krea2.versions[0]!.key]: 'Provider outage.' },
  });

  it('is neither offered nor marked unavailable while its rollout flag is off', () => {
    const off = new Set<string>();
    expect(cardsForMedia('image', off).map((c) => c.type)).not.toContain('krea2');
    expect(cardUnavailability(krea2, off, blocked)).toBeNull();
  });

  it('shows as unavailable with its note when the flag is on, and blocks a selection on it', () => {
    const on = new Set([krea2.flagKey!]);
    expect(cardsForMedia('image', on).map((c) => c.type)).toContain('krea2');
    expect(cardUnavailability(krea2, on, blocked)).toEqual({ reason: 'Provider outage.' });
    expect(cardUnavailability(cardByType('sdxl')!, on, blocked)).toBeNull();
    expect(blockedSelectionMessage([newRun(krea2, on)], blocked)).toBe(
      'Krea 2 is temporarily unavailable for training. Provider outage.'
    );
    expect(blockedSelectionMessage([newRun(krea2, on)], parseServiceStatus(null))).toBeNull();
  });
});

describe('a model that is down, in a shared ecosystem or a multi-version card', () => {
  const illustrious = cardByType('illustrious')!;
  const klein = cardByType('flux2klein')!;
  const on = new Set([klein.flagKey!]);

  it('checks a custom base by its own AIR, not the base it was picked under', () => {
    const status = parseServiceStatus({ blockedModels: ['pony'] });
    const custom = { ...newRun(illustrious, on), versionKey: CUSTOM_VERSION_KEY };
    const run = { ...custom, customAir: 'urn:air:sdxl:checkpoint:civitai:1@2' };
    expect(blockedSelectionMessage([run], status)).toBeNull();
    expect(
      blockedSelectionMessage([run], parseServiceStatus({ blockedModels: ['illustrious'] }))
    ).toBeNull();
    expect(
      blockedSelectionMessage([run], parseServiceStatus({ blockedModels: [run.customAir] }))
    ).toBe('This custom model is blocked from training. Pick another.');
  });

  it('blocks a code-blocked custom base even when the ops list is empty or unread', () => {
    const anima = { ...newRun(illustrious, on), versionKey: CUSTOM_VERSION_KEY };
    const run = { ...anima, customAir: 'urn:air:anima:checkpoint:civitai:2855007@3224434' };
    const message = 'This custom model is blocked from training. Pick another.';
    expect(blockedSelectionMessage([run], parseServiceStatus(null))).toBe(message);
    expect(blockedSelectionMessage([run], null)).toBe(message);
  });

  it('starts a partly-down card on a version that is up', () => {
    const status = parseServiceStatus({ blockedModels: ['flux2klein_9b'] });
    expect(cardUnavailability(klein, on, status)).toBeNull();
    expect(newRun(klein, on, status).versionKey).toBe('flux2klein_4b');
    expect(newRun(klein, on).versionKey).toBe('flux2klein_9b');
  });
});
