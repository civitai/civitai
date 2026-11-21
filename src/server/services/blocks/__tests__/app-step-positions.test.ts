import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptModule from '~/server/flipt/client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { STEP_MEDIA_INPUT_KEYS } from '~/server/services/blocks/step-media-keys';
import { resolveBlockWorkflowGraph } from '~/server/services/blocks/workflow-graph';
import {
  findInlineGraphProblem,
  findStepPositionProblem,
  stepPositionsRefusal,
} from '~/server/services/blocks/app-step-positions';

const h = vi.hoisted(() => ({ variant: vi.fn<() => Promise<string | null>>() }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptModule>()),
  getFliptVariant: () => h.variant(),
}));

const VIEWER = 42;
const ref = (extra: Record<string, unknown> = {}) => ({ $ref: '$arguments', path: 'v', ...extra });
// A reference to an earlier step's output, placed at run time.
const stepRef = () => ({ $ref: 'previous', path: 'output.images' });
const ownJob = `urn:air:sdxl:lora:orchestrator:${VIEWER}-20261121@epoch_5.safetensors`;
const otherJob = 'urn:air:sdxl:lora:orchestrator:7001-20261121@epoch_5.safetensors';
const blob = 'urn:air:sdxl:lora:orchestrator:blob@abc123.safetensors';

beforeEach(() => {
  h.variant.mockReset();
  h.variant.mockResolvedValue(null);
  loggingMock.logToAxiom.mockClear();
});

// Deliberate (#9955): media inputs may take references, URLs and orchestrator files, and every other key
// takes literals only, a key the list has not met included. Loosening this to a list of the keys
// that take model weights reopens what it closes; ask the moderation team first.
describe('findStepPositionProblem', () => {
  describe('references', () => {
    it.each([
      ['a weights key', { model: ref() }],
      ['a LoRA map value', { loras: { 'urn:air:sdxl:lora:civitai:1@2': ref() } }],
      ['a key the rule has not met', { someFutureModelField: ref() }],
      [
        'a reference that builds an AIR',
        { diffusionModel: ref({ format: 'sdxl:lora:civitai:1@{0}' }) },
      ],
      ['the whole input', ref()],
      ['an array under a weights key', { embeddings: [ref()] }],
      ['an uppercase key', { model: { $REF: '$arguments', path: 'v' } }],
    ])('refuses one at %s', (_label, input) => {
      expect(findStepPositionProblem(input, VIEWER)).toMatchObject({ form: 'reference' });
    });

    it.each([
      ['Mesh', { mesh: stepRef() }],
      ['SourceUrl', { sourceUrl: stepRef() }],
      ['an image list', { images: [stepRef()] }],
      ['a media key in another case', { SourceImage: stepRef() }],
      ['inside a media object', { trainingData: { type: 'blobs', items: [{ air: stepRef() }] } }],
    ])('lets one chain into %s', (_label, input) => {
      expect(findStepPositionProblem(input, VIEWER)).toBeNull();
    });

    it("leaves a repeat step's for clause to its template", () => {
      const clause = { $ref: '$arguments', path: 'items', as: 'item' };
      const repeat = (template: unknown) => ({ for: clause, template });
      expect(
        findStepPositionProblem(
          repeat({ input: { image: { $ref: 'item' } } }),
          VIEWER,
          { items: [] },
          'repeat'
        )
      ).toBeNull();
      expect(
        findStepPositionProblem(
          repeat({ input: { model: ref() } }),
          VIEWER,
          { items: [] },
          'repeat'
        )
      ).toMatchObject({ form: 'reference', key: 'model' });
      // A repeat nested in another step's template is exempt the same way.
      expect(
        findStepPositionProblem(
          { template: { $type: 'repeat', input: repeat({ input: { image: { $ref: 'item' } } }) } },
          VIEWER,
          { items: [] },
          'repeat'
        )
      ).toBeNull();
    });

    it('refuses a for/as reference in any step that is not a repeat', () => {
      expect(
        findStepPositionProblem(
          { for: { $ref: '$arguments', path: 'items', as: 'item' } },
          VIEWER,
          undefined,
          'imageGen'
        )
      ).toMatchObject({ form: 'reference', key: 'for' });
    });

    it('refuses an argument that places itself instead of overflowing', () => {
      const args: Record<string, unknown> = { a: { $ref: '$arguments', path: 'a' } };
      expect(findStepPositionProblem({ model: ref({ path: 'a' }) }, VIEWER, args)).toMatchObject({
        form: 'reference',
      });
    });
  });

  describe("references to the request's own arguments", () => {
    const args = {
      strength: 0.4,
      lora: blob,
      weights: 'https://bucket.abc.r2.cloudflarestorage.com/models/123/file',
      nested: { text: 'a cat' },
      Dup: 'a cat',
      dup: blob,
    };

    it('checks the value an argument places, where it lands', () => {
      expect(
        findStepPositionProblem({ strength: ref({ path: 'strength' }) }, VIEWER, args)
      ).toBeNull();
      expect(
        findStepPositionProblem({ prompt: ref({ path: 'nested.text' }) }, VIEWER, args)
      ).toBeNull();
      expect(findStepPositionProblem({ model: ref({ path: 'lora' }) }, VIEWER, args)).toMatchObject(
        {
          form: 'orchestrator-file',
          key: 'model',
        }
      );
      expect(findStepPositionProblem({ model: ref({ path: 'weights' }) }, VIEWER, args)).toEqual({
        form: 'url',
        key: 'model',
        host: 'bucket.abc.r2.cloudflarestorage.com',
      });
      expect(findStepPositionProblem({ image: ref({ path: 'weights' }) }, VIEWER, args)).toBeNull();
    });

    it.each([
      ['with a format', { model: ref({ path: 'strength', format: 'sdxl:lora:civitai:1@{0}' }) }],
      ['with a default', { model: ref({ path: 'strength', default: 1 }) }],
      ['to a path that does not resolve', { model: ref({ path: 'missing' }) }],
      ['to an inherited property', { model: ref({ path: 'constructor' }) }],
      ['to another step', { model: { $ref: 'gen', path: 'output.text' } }],
      ['to a key two arguments share but for case', { model: ref({ path: 'dup' }) }],
      ['to a path with an index', { model: ref({ path: 'nested[0]' }) }],
    ])('refuses one %s', (_label, input) => {
      expect(findStepPositionProblem(input, VIEWER, args)).toMatchObject({ form: 'reference' });
    });

    it('refuses one when the request carries no arguments', () => {
      expect(
        findStepPositionProblem({ strength: ref({ path: 'strength' }) }, VIEWER)
      ).toMatchObject({ form: 'reference' });
    });
  });

  describe('URLs', () => {
    it('refuses one at a weights key, reporting the host only', () => {
      const problem = findStepPositionProblem(
        { model: 'https://bucket.abc.r2.cloudflarestorage.com/models/123/file' },
        VIEWER
      );
      expect(problem).toEqual({
        form: 'url',
        key: 'model',
        host: 'bucket.abc.r2.cloudflarestorage.com',
      });
    });

    it('refuses one as a LoRA map key', () => {
      expect(
        findStepPositionProblem({ loras: { 'https://x.example/f': 1 } }, VIEWER)
      ).toMatchObject({ form: 'url', key: 'loras' });
    });

    it('refuses one with a space in it', () => {
      expect(
        findStepPositionProblem(
          { model: 'https://bucket.abc.r2.cloudflarestorage.com/m 1' },
          VIEWER
        )
      ).toMatchObject({ form: 'url', key: 'model' });
    });

    it('lets one through at a media key', () => {
      expect(
        findStepPositionProblem({ image: 'https://image.civitai.com/x/y.jpeg' }, VIEWER)
      ).toBeNull();
    });

    it('leaves chat text and tool schemas alone, but not a reference in them', () => {
      const chat = {
        messages: [{ role: 'user', content: 'https://example.com/a.png' }],
        tools: [{ function: { parameters: { url: 'https://example.com' } } }],
      };
      expect(findStepPositionProblem(chat, VIEWER)).toBeNull();
      expect(
        findStepPositionProblem({ messages: [{ role: 'user', content: ref() }] }, VIEWER)
      ).toMatchObject({ form: 'reference', key: 'content' });
    });

    it("refuses another user's file named in chat text, and lets the viewer's own through", () => {
      const say = (content: string) => ({ messages: [{ role: 'user', content }] });
      expect(findStepPositionProblem(say(`use (${otherJob}) please`), VIEWER)).toMatchObject({
        form: 'orchestrator-file',
        key: 'content',
      });
      expect(findStepPositionProblem(say(`see "${blob}".`), VIEWER)).toMatchObject({
        form: 'orchestrator-file',
      });
      expect(findStepPositionProblem(say(`use ${ownJob} please`), VIEWER)).toBeNull();
      expect(findStepPositionProblem(say('the orchestrator: a word'), VIEWER)).toBeNull();
    });

    it('leaves a sentence that contains a link alone', () => {
      expect(
        findStepPositionProblem({ prompt: 'a cat, see https://example.com for more' }, VIEWER)
      ).toBeNull();
    });
  });

  describe('orchestrator files', () => {
    it("refuses another user's job file and any blob at a weights key", () => {
      expect(findStepPositionProblem({ loras: { [otherJob]: 1 } }, VIEWER)).toMatchObject({
        form: 'orchestrator-file',
      });
      expect(findStepPositionProblem({ model: blob }, VIEWER)).toMatchObject({
        form: 'orchestrator-file',
      });
    });

    it('refuses one the AIR grammar cannot read', () => {
      expect(
        findStepPositionProblem({ model: 'urn:air:sdxl:lora:orchestrator:blob@a b' }, VIEWER)
      ).toMatchObject({ form: 'orchestrator-file' });
    });

    it('reports a LoRA map entry as the map, never its key', () => {
      expect(
        findStepPositionProblem({ loras: { 'urn:air:sdxl:lora:civitai:1@2': ref() } }, VIEWER)
      ).toEqual({
        form: 'reference',
        key: 'loras',
      });
    });

    it('holds continueFrom to the rule: it carries weights', () => {
      expect(findStepPositionProblem({ continueFrom: blob }, VIEWER)).toMatchObject({
        form: 'orchestrator-file',
        key: 'continueFrom',
      });
    });

    it("lets the viewer's own job file through", () => {
      expect(findStepPositionProblem({ loras: { [ownJob]: 1 } }, VIEWER)).toBeNull();
      expect(findStepPositionProblem({ model: ownJob }, VIEWER)).toBeNull();
    });

    it('refuses a blob at a media key', () => {
      expect(
        findStepPositionProblem({ trainingData: { type: 'blobs', items: [{ air: blob }] } }, VIEWER)
      ).toMatchObject({ form: 'media-reference', key: 'air' });
    });
  });

  it('leaves literal civitai AIRs and ordinary values to the resource check', () => {
    expect(
      findStepPositionProblem(
        { model: 'urn:air:sdxl:checkpoint:civitai:1@2', prompt: 'a cat', steps: 20 },
        VIEWER
      )
    ).toBeNull();
  });
});

describe('media references (#9982)', () => {
  const civitaiImage = 'urn:air:other:image:civitai:12345';
  const blobKey = 'JNFDW54JNTATNW42HACYCWSQP0';
  const inputs: [string, (value: unknown) => unknown][] = [
    ['a controlnet image', (v) => ({ controlNets: [{ preprocessor: 'canny', image: v }] })],
    ['prompt-enhancement images', (v) => ({ prompt: 'a cat', images: [v] })],
    ['a TTS refAudioUrl', (v) => ({ text: 'hello', refAudioUrl: v })],
    [
      'a training item air',
      (v) => ({ trainingData: { type: 'blobs', items: [{ air: v, caption: 'a cat' }] } }),
    ],
  ];
  const refused: [string, string][] = [
    ["another user's job file", otherJob],
    ['a blob AIR', blob],
    ['a Civitai image AIR', civitaiImage],
    ['a bare blob key', blobKey],
    ['a bare blob key with an extension', `${blobKey}.png`],
    ['a bare number', '12345'],
  ];

  describe.each(inputs)('at %s', (_input, build) => {
    it.each(refused)('refuses %s', (_label, value) => {
      expect(findStepPositionProblem(build(value), VIEWER)).toMatchObject({
        form: 'media-reference',
      });
    });

    it('refuses one placed through the arguments', () => {
      expect(findStepPositionProblem(build(ref()), VIEWER, { v: blob })).toMatchObject({
        form: 'media-reference',
      });
    });

    it("lets the viewer's own job file, a URL and a data URI through", () => {
      for (const value of [
        ownJob,
        'https://image.civitai.com/x/y.png',
        'data:image/png;base64,AAAA',
      ])
        expect(findStepPositionProblem(build(value), VIEWER)).toBeNull();
    });
  });

  it.each(['12345', blobKey, 'scene: 00:01, style:anime'])(
    "reads a training item's caption %s as text",
    (caption) => {
      expect(
        findStepPositionProblem(
          { trainingData: { type: 'blobs', items: [{ air: ownJob, caption }] } },
          VIEWER
        )
      ).toBeNull();
    }
  );

  it.each([
    ['a training blob key', 'a'.repeat(32) + '.zip'],
    ['a blob path on another host', `https://example.com/v2/consumer/blobs/${blobKey}`],
    ['an encoded blob path on another host', `https://example.com/v2/consumer%2Fblobs/${blobKey}`],
  ])('refuses %s', (_label, value) => {
    expect(
      findStepPositionProblem({ trainingData: { type: 'blobs', items: [{ air: value }] } }, VIEWER)
    ).toMatchObject({ form: 'media-reference', key: 'air' });
    expect(findStepPositionProblem({ image: value }, VIEWER)).toMatchObject({
      form: 'media-reference',
    });
  });

  it.each([
    ['an escaped backslash path', `https://example.com/v2/consumer%5Cblobs/${blobKey}`],
    ['a malformed escape', `https://example.com/v2/consumer/blobs/%E0%A4%A`],
  ])('refuses a blob URL on another host with %s', (_label, value) => {
    expect(findStepPositionProblem({ image: value }, VIEWER)).toMatchObject({
      form: 'media-reference',
    });
  });

  it.each([
    ['a short Civitai AIR', 'https:civitai:12345'],
    ['a Civitai image AIR', 'https:urn:air:other:image:civitai:12345'],
    ["another user's job file", 'https:orchestrator:7001-20261121@epoch_5.safetensors'],
  ])('refuses %s behind a scheme with no slashes', (_label, value) => {
    expect(findStepPositionProblem({ image: value }, VIEWER)).toMatchObject({
      form: 'media-reference',
      key: 'image',
    });
  });

  it('refuses a colon in a non-caption field of a media object', () => {
    expect(
      findStepPositionProblem(
        { keyframes: [{ image: 'https://image.civitai.com/x/y.png', label: 'start: 00:01' }] },
        VIEWER
      )
    ).toMatchObject({ form: 'media-reference', key: 'label' });
  });

  it.each(['orchestrator://x@y.safetensors', 'civitai://12345', 'ftp://example.com/a.png'])(
    'refuses %s, a scheme other than http(s)',
    (value) => {
      expect(findStepPositionProblem({ image: value }, VIEWER)).toMatchObject({
        form: 'media-reference',
        key: 'image',
      });
    }
  );

  it("passes a real URL and the viewer's own job file", () => {
    for (const value of ['https://image.civitai.com/x/y.png', 'http://example.com/a.png', ownJob])
      expect(findStepPositionProblem({ image: value }, VIEWER)).toBeNull();
  });

  it("leaves a blob URL on the orchestrator's own host to the source gate", () => {
    expect(
      findStepPositionProblem(
        { image: `https://orchestration.civitai.com/v2/consumer/blobs/${blobKey}` },
        VIEWER
      )
    ).toBeNull();
  });

  it.each([
    ['an extension-less training key', 'b'.repeat(32)],
    ['a number', 12345],
  ])('refuses %s', (_label, value) => {
    expect(findStepPositionProblem({ image: value }, VIEWER)).toMatchObject({
      form: 'media-reference',
      key: 'image',
    });
    expect(
      findStepPositionProblem({ trainingData: { type: 'blobs', items: [{ air: value }] } }, VIEWER)
    ).toMatchObject({ form: 'media-reference', key: 'air' });
  });

  it.each([
    ['reasoning', { $ref: 'chat', path: 'output.choices[0].message.reasoning_content' }],
    ['a refusal', { $ref: 'chat', path: 'output.choices[0].message.refusal' }],
    ['no path', { $ref: 'chat' }],
  ])('refuses a step output that is not media (%s) at a media key', (_label, reference) => {
    expect(findStepPositionProblem({ image: reference }, VIEWER)).toMatchObject({
      form: 'reference',
      key: 'image',
    });
  });

  it("refuses a step's text output at a media key, and passes its media output", () => {
    expect(
      findStepPositionProblem({ image: { $ref: 'chat', path: 'output.text' } }, VIEWER)
    ).toMatchObject({ form: 'reference', key: 'image' });
    expect(
      findStepPositionProblem({ image: { $ref: 'gen', path: 'output.images[0].url' } }, VIEWER)
    ).toBeNull();
  });

  describe('a repeat over the arguments', () => {
    const repeat = (path = 'items') => ({
      for: { $ref: '$arguments', path, as: 'item' },
      template: { $type: 'imageGen', input: { prompt: 'a cat', image: { $ref: 'item' } } },
    });

    it.each([
      ["another user's job file", otherJob],
      ['a blob AIR', blob],
      ['a bare blob key', blobKey],
    ])('refuses an item holding %s placed at a media key', (_label, value) => {
      expect(
        findStepPositionProblem(repeat(), VIEWER, { items: [ownJob, value] }, 'repeat')
      ).toMatchObject({ form: 'media-reference', key: 'image' });
    });

    it.each([
      ['as', { $ref: '$arguments', path: 'items', as: 5 }],
      ['$ref', { $ref: ['$arguments'], path: 'items', as: 'item' }],
      ['path', { $ref: '$arguments', path: { p: 'items' }, as: 'item' }],
    ])('refuses a clause whose %s is not a string', (_label, clause) => {
      const input = {
        for: clause,
        template: { $type: 'imageGen', input: { image: { $ref: 'item' } } },
      };
      expect(findStepPositionProblem(input, VIEWER, { items: [] }, 'repeat')).toMatchObject({
        form: 'reference',
        key: 'for',
      });
    });

    it.each([
      ['a caption', { caption: blobKey }],
      ['a number field', { n: 12345 }],
    ])('refuses what the loop path picks out of %s', (_label, item) => {
      const field = Object.keys(item)[0];
      const input = {
        for: { $ref: '$arguments', path: 'items', as: 'item' },
        template: { $type: 'imageGen', input: { image: { $ref: 'item', path: field } } },
      };
      expect(findStepPositionProblem(input, VIEWER, { items: [item] }, 'repeat')).toMatchObject({
        form: 'media-reference',
        key: 'image',
      });
    });

    it.each([
      ['a caption', { caption: blobKey }],
      ['a number field', { n: 12345 }],
    ])('refuses a whole item placed at a media key with %s in it', (_label, item) => {
      expect(findStepPositionProblem(repeat(), VIEWER, { items: [item] }, 'repeat')).toMatchObject({
        form: 'media-reference',
        key: 'image',
      });
    });

    it('refuses a loop path that does not resolve on every item, and passes one that does', () => {
      const input = {
        for: { $ref: '$arguments', path: 'items', as: 'item' },
        template: { $type: 'imageGen', input: { image: { $ref: 'item', path: 'src' } } },
      };
      const url = 'https://image.civitai.com/x/y.png';
      expect(
        findStepPositionProblem(input, VIEWER, { items: [{ src: url }, {}] }, 'repeat')
      ).toMatchObject({ form: 'reference', key: 'image' });
      expect(
        findStepPositionProblem(input, VIEWER, { items: [{ src: url }, { src: ownJob }] }, 'repeat')
      ).toBeNull();
    });

    it('refuses a clause that does not name an array in the arguments', () => {
      for (const args of [{}, { items: ownJob }])
        expect(findStepPositionProblem(repeat(), VIEWER, args, 'repeat')).toMatchObject({
          form: 'reference',
          key: 'for',
        });
    });

    it.each(['$ARGUMENTS', '$arguments', 'Gen'])(
      'refuses a loop variable named %s, like the arguments or a step',
      (as) => {
        const input = {
          for: { $ref: '$arguments', path: 'items', as },
          template: { $type: 'imageGen', input: { image: { $ref: '$arguments', path: 'img' } } },
        };
        expect(
          findStepPositionProblem(
            input,
            VIEWER,
            { items: ['https://image.civitai.com/x/y.png'], img: blob },
            'repeat',
            new Set(['gen'])
          )
        ).toMatchObject({ form: 'reference', key: 'for' });
      }
    );

    it("lets the viewer's own files and URLs through", () => {
      expect(
        findStepPositionProblem(
          repeat(),
          VIEWER,
          { items: [ownJob, 'https://image.civitai.com/x/y.png'] },
          'repeat'
        )
      ).toBeNull();
    });
  });

  it('refuses a recased default end to end', () => {
    const input = { prompt: 'a cat', image: { $ref: '$arguments', path: 'v', Default: blob } };
    const graph = resolveBlockWorkflowGraph({
      steps: [{ $type: 'imageGen', input }],
      arguments: { v: ownJob },
    });
    expect(graph.ok).toBe(false);
    expect(findStepPositionProblem(input, VIEWER, { v: ownJob })).toMatchObject({
      form: 'media-reference',
      key: 'image',
    });
  });

  describe('references at a media key', () => {
    const step = (extra: Record<string, unknown> = {}) => ({
      $ref: 'previous',
      path: 'output.blobs',
      ...extra,
    });

    it.each([
      ["another user's job file", otherJob],
      ['a blob AIR', blob],
      ['a bare blob key', blobKey],
    ])('refuses a default holding %s', (_label, value) => {
      for (const reference of [step({ default: value }), ref({ default: value })])
        expect(findStepPositionProblem({ image: reference }, VIEWER, { v: ownJob })).toMatchObject({
          form: 'media-reference',
          key: 'image',
        });
    });

    it('refuses a formatted reference', () => {
      expect(
        findStepPositionProblem({ image: ref({ format: '{0}' }) }, VIEWER, { v: ownJob })
      ).toMatchObject({ form: 'reference', key: 'image' });
      expect(findStepPositionProblem({ image: step({ format: '{0}' }) }, VIEWER)).toMatchObject({
        form: 'reference',
      });
    });

    it('refuses an arguments reference that does not resolve', () => {
      expect(findStepPositionProblem({ image: ref() }, VIEWER, {})).toMatchObject({
        form: 'reference',
        key: 'image',
      });
    });

    it("checks an arguments reference's value when it also carries a default", () => {
      expect(
        findStepPositionProblem({ image: ref({ default: ownJob }) }, VIEWER, { v: blob })
      ).toMatchObject({ form: 'media-reference' });
      expect(
        findStepPositionProblem({ image: ref({ default: ownJob }) }, VIEWER, { v: ownJob })
      ).toBeNull();
    });

    it("lets a reference to another step's output through, with an own default", () => {
      expect(findStepPositionProblem({ image: step() }, VIEWER)).toBeNull();
      expect(findStepPositionProblem({ image: step({ default: ownJob }) }, VIEWER)).toBeNull();
    });
  });

  it('leaves an air outside training data to the weights rule', () => {
    expect(
      findStepPositionProblem(
        { resources: [{ air: 'urn:air:sdxl:checkpoint:civitai:1@2' }] },
        VIEWER
      )
    ).toBeNull();
    expect(
      findStepPositionProblem({ resources: [{ air: 'https://example.com/w.safetensors' }] }, VIEWER)
    ).toMatchObject({ form: 'url', key: 'air' });
  });

  it('leaves a number at a key that is not media alone', () => {
    expect(findStepPositionProblem({ seed: '12345', steps: 20 }, VIEWER)).toBeNull();
  });
});

describe('media keys', () => {
  it("are the prompt audit's list, plus trainingData", () => {
    for (const key of ['blob', 'frames', 'keyframes', 'url', 'sampleInputImages']) {
      expect(STEP_MEDIA_INPUT_KEYS.has(key.toLowerCase())).toBe(true);
      expect(findStepPositionProblem({ [key]: stepRef() }, VIEWER)).toBeNull();
    }
    expect(STEP_MEDIA_INPUT_KEYS.has('trainingdata')).toBe(false);
  });

  it('let a keyframed video app chain earlier outputs', async () => {
    await expect(
      stepPositionsRefusal({
        appBlockId: 'apb_1',
        viewerId: VIEWER,
        steps: [
          { $type: 'imageGen', name: 'gen', input: { prompt: 'a cat' } },
          {
            $type: 'videoGen',
            name: 'vid',
            input: {
              prompt: 'the cat walks',
              keyframes: [{ image: { $ref: 'gen', path: 'output.images[0].url' }, frame: 0 }],
              frames: { $ref: 'gen', path: 'output.images' },
            },
          },
        ],
      })
    ).resolves.toBeNull();
  });
});

describe('free text', () => {
  // A long run of punctuation before a letter is the worst case for a backtracking trim. The
  // bound is loose for a loaded runner; the regex this replaced took 395 ms and 5.7 s here.
  it.each([
    ['dots then a letter', `orchestrator:${'.'.repeat(20_000)}x`],
    ['one long token', `orchestrator:${'a'.repeat(100_000)}`],
  ])('scans %s in linear time and refuses it unread', (_n, token) => {
    const started = performance.now();
    const problem = findStepPositionProblem({ messages: [{ content: token }] }, VIEWER);
    expect(performance.now() - started).toBeLessThan(200);
    expect(problem).toMatchObject({ form: 'orchestrator-file' });
  });

  it('skips tokens that do not name the orchestrator', () => {
    const started = performance.now();
    expect(
      findStepPositionProblem({ messages: [{ content: `${'.'.repeat(80_000)}x` }] }, VIEWER)
    ).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('merge steps', () => {
  const field = (over: Record<string, unknown> = {}) => ({
    $ref: 'gen',
    path: 'output.images',
    reduce: 'concat',
    ...over,
  });
  const run = (merge: { $type: string; input: unknown }) =>
    stepPositionsRefusal({
      appBlockId: 'apb_1',
      viewerId: VIEWER,
      steps: [
        { $type: 'imageGen', name: 'gen', input: {} },
        { name: 'm', ...merge },
      ],
    });

  it("lets a merge read an earlier step's output", async () => {
    await expect(run({ $type: 'merge', input: { fields: { tags: field() } } })).resolves.toBeNull();
  });

  it.each([
    ['at a step that is not a merge', { $type: 'imageGen', input: { fields: { tags: field() } } }],
    [
      'naming no earlier step',
      { $type: 'merge', input: { fields: { tags: field({ $ref: 'm' }) } } },
    ],
    [
      'naming the arguments',
      { $type: 'merge', input: { fields: { tags: field({ $ref: '$arguments' }) } } },
    ],
    ['with another key', { $type: 'merge', input: { fields: { tags: field({ default: 1 }) } } }],
    [
      'without a reduce',
      { $type: 'merge', input: { fields: { tags: field({ reduce: undefined }) } } },
    ],
    ['outside fields', { $type: 'merge', input: { other: field() } }],
  ])('refuses a merge-shaped reference %s', async (_n, step) => {
    await expect(run(step)).resolves.toMatch(/cannot take/);
  });
});

describe('findInlineGraphProblem', () => {
  const graph = (inputs: Record<string, unknown>) => ({
    resources: ['urn:air:sdxl:checkpoint:civitai:1@2'],
    workflow: {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x' } },
      '2': { class_type: 'KSampler', inputs },
    },
  });

  it('refuses a reference in any node input, and a fake link that carries one', () => {
    expect(findInlineGraphProblem(graph({ seed: ref() }), VIEWER)).toEqual({
      form: 'reference',
      key: 'seed',
    });
    expect(findInlineGraphProblem(graph({ model: [ref()] }), VIEWER)).toMatchObject({
      form: 'reference',
    });
  });

  it('refuses an orchestrator file, with or without the urn prefix', () => {
    expect(findInlineGraphProblem(graph({ model: 'orchestrator:blob@abc' }), VIEWER)).toMatchObject(
      {
        form: 'orchestrator-file',
        key: 'model',
      }
    );
  });

  it('lets a real link, a literal and a media URL through', () => {
    expect(
      findInlineGraphProblem(
        graph({ model: ['1', 0], seed: 4, image: 'https://image.civitai.com/x.jpeg' }),
        VIEWER
      )
    ).toBeNull();
  });

  it('holds an orchestrator file to the owner, as the other arms do', () => {
    expect(findInlineGraphProblem(graph({ lora: otherJob }), VIEWER)).toMatchObject({
      form: 'orchestrator-file',
    });
    expect(findInlineGraphProblem(graph({ lora: ownJob }), VIEWER)).toBeNull();
  });
});

describe('stepPositionsRefusal', () => {
  const steps = [{ $type: 'imageGen', input: { model: ref() } }];

  it.each([
    ['a missing flag', null],
    ['enforce', 'enforce'],
    ['an unknown variant', 'something-else'],
  ])('refuses under %s and logs the key, never the value', async (_label, variant) => {
    h.variant.mockResolvedValue(variant);
    await expect(
      stepPositionsRefusal({ appBlockId: 'apb_1', viewerId: VIEWER, steps })
    ).resolves.toMatch(/'model'/);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app-step-position-refused',
        appBlockId: 'apb_1',
        stepType: 'imageGen',
        key: 'model',
        payload: { form: 'reference' },
        mode: 'enforce',
      })
    );
    expect(JSON.stringify(loggingMock.logToAxiom.mock.calls)).not.toContain('$arguments');
  });

  it('logs but lets it through under log', async () => {
    h.variant.mockResolvedValue('log');
    await expect(
      stepPositionsRefusal({ appBlockId: 'apb_1', viewerId: VIEWER, steps })
    ).resolves.toBeNull();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'log', key: 'model' })
    );
  });

  it('neither refuses nor logs under off', async () => {
    h.variant.mockResolvedValue('off');
    await expect(
      stepPositionsRefusal({ appBlockId: 'apb_1', viewerId: VIEWER, steps })
    ).resolves.toBeNull();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });
});
