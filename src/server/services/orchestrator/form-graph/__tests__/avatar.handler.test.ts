import { describe, expect, it } from 'vitest';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { findAvatarStarter } from '~/shared/constants/avatar-starters';
import {
  avatarStyleByKey,
  buildAvatarEditPrompt,
  buildAvatarRestylePrompt,
} from '~/shared/constants/avatar-styles.constants';
import { nanoBananaVersionIds } from '~/shared/form-graph/generation/image/nano-banana.graph';
import { openaiVersionIds } from '~/shared/form-graph/generation/image/openai.graph';
import { krea2VersionIds } from '~/shared/form-graph/generation/image/krea2.graph';
import { krea3VersionId } from '~/shared/form-graph/generation/image/krea3.graph';
import { flux3KleinVersionIds } from '~/shared/form-graph/generation/image/flux3-klein.graph';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/generation/context';
import { createAvatarSteps, expandAvatarData } from '../avatar.handler';
import type { GenerationHandlerCtx } from '../../handlers';
import type { GenerationData, LooseGenerationData } from '../types';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const PORTRAIT = {
  url: 'https://orchestration.civitai.com/v2/consumer/blobs/portrait.jpg',
  width: 1024,
  height: 1024,
};
const RESULT = 'https://orchestration.civitai.com/v2/consumer/blobs/result.png';

const starterUrl = (styleKey: string, character: string, copy: 'colour' | 'grey') =>
  getEdgeUrl(findAvatarStarter(styleKey, character)![copy].url, { original: true });

function parse(input: Record<string, unknown>) {
  const parsed = generationHub.parse(
    {
      workflow: 'img2img:avatar',
      images: [PORTRAIT],
      // Most cases cover the reference recipe on Nano Banana; Krea 3, the default, is tested on its own.
      model: { id: nanoBananaVersionIds.v2, model: { type: 'Checkpoint' } },
      ...input,
    },
    EXT
  );
  if (!parsed.success) throw new Error(`parse failed: ${JSON.stringify(parsed.errors)}`);
  return parsed.data as GenerationData;
}

const expand = (input: Record<string, unknown>) =>
  expandAvatarData(parse(input)) as LooseGenerationData;

const ctx = {
  airs: { getOrThrow: (id: number) => `urn:air:test:${id}` },
  user: { id: 1, isModerator: false },
  baseStepIndex: 0,
} as unknown as GenerationHandlerCtx;

const editInput = async (input: Record<string, unknown>) =>
  (createAvatarSteps(expand(input), ctx)[0] as { input: Record<string, unknown> }).input;

describe('img2img:avatar graph', () => {
  it('refuses a submission without a portrait', () => {
    expect(generationHub.parse({ workflow: 'img2img:avatar' }, EXT).success).toBe(false);
  });

  it('drops the palette choice on a fixed-palette style', async () => {
    expect(expand({ avatarStyle: 'ghibli-kiki', avatarPalette: 'neon' }).avatarPalette).toBe(
      'neon'
    );
    expect(expand({ avatarStyle: 'c64', avatarPalette: 'neon' }).avatarPalette).toBeUndefined();
  });
});

describe('expandAvatarData', () => {
  it('sends the portrait first and the starter reference second, in greyscale', async () => {
    const input = await editInput({ avatarStyle: 'art-nouveau', avatarReference: 'dev' });
    expect(input).toMatchObject({
      engine: 'google',
      model: 'nano-banana-2',
      images: [PORTRAIT.url, starterUrl('art-nouveau', 'dev', 'grey')],
    });
  });

  it('sends a fixed-palette style its starter in colour', async () => {
    const input = await editInput({ avatarStyle: 'c64' });
    expect(input.images).toEqual([PORTRAIT.url, starterUrl('c64', 'mara', 'colour')]);
  });

  it('defaults to Krea 3 and builds the request for the selected model version', async () => {
    expect(expand({ avatarStyle: 'art-nouveau', model: undefined }).model).toMatchObject({
      id: krea3VersionId,
    });
    const pro = { id: nanoBananaVersionIds.pro, model: { type: 'Checkpoint' } };
    const gpt = { id: openaiVersionIds['v2.5-flare'], model: { type: 'Checkpoint' } };
    expect(await editInput({ model: pro })).toMatchObject({ model: 'nano-banana-pro' });
    expect(await editInput({ model: gpt })).toMatchObject({
      engine: 'openai',
      model: 'gpt-image-2.5-flare',
    });
  });

  it('keeps the model to the avatar versions', async () => {
    const other = { id: nanoBananaVersionIds.standard, model: { type: 'Checkpoint' } };
    expect(expand({ model: other }).model).toMatchObject({ id: krea3VersionId });
  });

  it('builds the prompt from the style and the palette', async () => {
    const style = avatarStyleByKey.get('art-nouveau')!;
    const data = expand({ avatarStyle: style.key, avatarPalette: 'moonlit' });
    expect(data.prompt).toBe(buildAvatarEditPrompt(style, { palette: 'moonlit' }));
  });

  it('takes no reference but a starter character', () => {
    const data = expand({
      avatarStyle: 'art-nouveau',
      avatarReference: 'https://evil.example/x.png',
    });
    expect(data.avatarReferenceUrl).toBe(starterUrl('art-nouveau', 'mara', 'grey'));
  });
});

describe('refining on a reference model', () => {
  it('sends the earlier result in colour with the refine prompt, not as a style reference', async () => {
    const input = await editInput({
      avatarStyle: 'art-nouveau',
      avatarParentImage: RESULT,
    });
    expect(input.images).toEqual([PORTRAIT.url, RESULT]);
    expect(input.prompt).toContain('earlier avatar of the same person');
    expect(input.prompt).not.toContain('do not copy');
  });

  it('refines from a result served on the region proxy', async () => {
    const proxied = 'https://orchestration-proxy.civitai.com/v2/consumer/blobs/result.png';
    const input = await editInput({
      avatarStyle: 'art-nouveau',
      avatarParentImage: proxied,
    });
    expect(input.images).toEqual([PORTRAIT.url, proxied]);
  });

  it.each([
    'https://evil.example/v2/consumer/blobs/result.png',
    'http://orchestration-proxy.civitai.com/v2/consumer/blobs/result.png',
    'https://user@orchestration-proxy.civitai.com/v2/consumer/blobs/result.png',
    'https://orchestration-proxy.civitai.com.evil.example/v2/consumer/blobs/result.png',
  ])('refuses to refine from %s', (elsewhere) => {
    expect(() =>
      expand({
        avatarStyle: 'art-nouveau',
        avatarParentImage: elsewhere,
      })
    ).toThrow("This result can't be refined");
  });
});

describe('seed', () => {
  // The form has no seed; generateFromGraph draws one per submit. Without it on the step, Krea 2
  // drew every image of a batch from the same default seed.
  it.each([
    ['Krea 2', krea2VersionIds.raw],
    ['Nano Banana 2', nanoBananaVersionIds.v2],
  ])('passes the submit seed through on %s', async (_label, versionId) => {
    const data = expand({ model: { id: versionId, model: { type: 'Checkpoint' } } });
    const [step] = createAvatarSteps({ ...data, seed: 1850800956 }, ctx) as [
      { input: Record<string, unknown> }
    ];
    expect(step.input.seed).toBe(1850800956);
  });
});

describe('Krea 2', () => {
  const krea = { id: krea2VersionIds.raw, model: { type: 'Checkpoint' } };

  it('restyles the portrait alone with the style LoRA', async () => {
    const style = avatarStyleByKey.get('art-nouveau')!;
    const input = await editInput({ avatarStyle: style.key, model: krea });
    expect(input).toMatchObject({
      engine: 'comfy',
      ecosystem: 'krea2',
      diffusionModel: `urn:air:test:${krea2VersionIds.raw}`,
      images: [PORTRAIT.url],
      loras: { [`urn:air:test:${style.lora}`]: 1 },
    });
    expect(input.prompt).toContain(style.stylePrompt);
  });

  it('refines from an earlier result, sent as the second image in colour', async () => {
    const input = await editInput({
      avatarStyle: 'art-nouveau',
      model: krea,
      avatarParentImage: RESULT,
    });
    expect(input.images).toEqual([PORTRAIT.url, RESULT]);
    expect(input.prompt).toContain('earlier avatar of the same person');
  });

  it('sends a style without a LoRA on its description alone', async () => {
    const input = await editInput({ avatarStyle: 'stained-glass', model: krea });
    expect(input.loras).toBeUndefined();
  });
});

describe('Krea 3', () => {
  it('sends the portrait and the starter reference with the edit prompt', async () => {
    const style = avatarStyleByKey.get('art-nouveau')!;
    const input = await editInput({
      avatarStyle: style.key,
      model: { id: krea3VersionId, model: { type: 'Checkpoint' } },
    });
    expect(input).toMatchObject({
      engine: 'krea3',
      images: [PORTRAIT.url, starterUrl('art-nouveau', 'mara', 'grey')],
      thinkingMode: 'instant',
    });
    expect(input.prompt).toContain('The second image is only a sample of the art style.');
  });
});

describe('Flux 3 Klein', () => {
  const klein = { id: flux3KleinVersionIds.distilled, model: { type: 'Checkpoint' } };

  // Given a reference, Klein draws the reference's person.
  it('restyles the portrait alone, without the Krea 2 LoRA', async () => {
    const style = avatarStyleByKey.get('art-nouveau')!;
    const data = expand({ avatarStyle: style.key, model: klein });
    expect(data.resources).toEqual([]);
    const input = await editInput({ avatarStyle: style.key, model: klein });
    expect(input).toMatchObject({
      engine: 'comfy',
      ecosystem: 'flux3Klein',
      model: 'distilled',
      images: [PORTRAIT.url],
      prompt: buildAvatarRestylePrompt(style),
    });
    expect(input.loras).toBeUndefined();
  });

  it('refines from an earlier result, sent as the second image', async () => {
    const input = await editInput({
      avatarStyle: 'art-nouveau',
      model: klein,
      avatarParentImage: RESULT,
    });
    expect(input.images).toEqual([PORTRAIT.url, RESULT]);
  });
});

describe('buildAvatarEditPrompt', () => {
  it('asks for the reference colours only on fixed-palette styles', () => {
    const fixed = buildAvatarEditPrompt(avatarStyleByKey.get('c64')!, { palette: 'neon' });
    expect(fixed).toContain('colour palette, lighting and mood of the second image');
    expect(fixed).not.toContain('neon');

    const free = buildAvatarEditPrompt(avatarStyleByKey.get('art-nouveau')!, { palette: 'neon' });
    expect(free).toContain('neon pink');
    expect(free).toContain('natural skin and hair colour');
  });

  it('defaults to the photo’s own colours', () => {
    expect(
      buildAvatarEditPrompt(avatarStyleByKey.get('art-nouveau')!, { palette: 'natural' })
    ).toContain('natural colours of the photo');
  });

  it('names the style in words and what not to take from the reference', () => {
    const style = avatarStyleByKey.get('vaporwave')!;
    const prompt = buildAvatarEditPrompt(style);
    expect(prompt).toContain(style.stylePrompt);
    expect(prompt).toContain('do not copy their face, hair, body, clothing or pose');
  });

  it('keeps the face of everyone else, with no text', () => {
    const style = avatarStyleByKey.get('art-nouveau')!;
    for (const prompt of [
      buildAvatarEditPrompt(style),
      buildAvatarEditPrompt(style, { refining: true }),
      buildAvatarRestylePrompt(style),
    ]) {
      expect(prompt).toContain('facial features');
      expect(prompt).toContain('No text');
    }
  });

  it('keeps a reimagined person recognisable by more than the face', () => {
    const prompt = buildAvatarEditPrompt(avatarStyleByKey.get('anthropomorphic')!);
    expect(prompt).toContain('recognisable from the first image through their expression');
    expect(prompt).not.toContain('facial features');
    expect(buildAvatarRestylePrompt(avatarStyleByKey.get('anthropomorphic')!)).not.toContain(
      'facial features'
    );
    expect(
      buildAvatarEditPrompt(avatarStyleByKey.get('anthropomorphic')!, { refining: true })
    ).not.toContain('facial features');
  });
});

describe('Character option', () => {
  it('is offered only on styles that declare it', async () => {
    expect(expand({ avatarStyle: 'frazetta', avatarCharacter: 'orc' }).avatarCharacter).toBe('orc');
    expect(
      expand({ avatarStyle: 'art-nouveau', avatarCharacter: 'orc' }).avatarCharacter
    ).toBeUndefined();
  });

  it('asks for clothing that fits the character, not the photo’s own', () => {
    const prompt = buildAvatarEditPrompt(avatarStyleByKey.get('frazetta')!, { character: 'elf' });
    expect(prompt).toContain('pointed ears');
    expect(prompt).toContain('clothing that suits an elf');
    expect(prompt).not.toContain('real skin, hair and clothing colours');
  });

  it('stops keeping the natural skin colour when the character changes it', () => {
    const style = avatarStyleByKey.get('frazetta')!;
    expect(buildAvatarEditPrompt(style, { character: 'orc' })).toContain('natural hair colour');
    expect(buildAvatarEditPrompt(style, { character: 'dwarf' })).toContain(
      'natural skin and hair colour'
    );
  });
});
