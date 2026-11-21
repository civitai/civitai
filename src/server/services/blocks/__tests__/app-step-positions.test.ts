import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptModule from '~/server/flipt/client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { STEP_MEDIA_INPUT_KEYS } from '~/server/services/blocks/step-media-keys';
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
      ['Mesh', { mesh: ref() }],
      ['SourceUrl', { sourceUrl: ref() }],
      ['an image list', { images: [ref()] }],
      ['a media key in another case', { SourceImage: ref() }],
      ['inside a media object', { trainingData: { type: 'blobs', items: [{ air: ref() }] } }],
    ])('lets one chain into %s', (_label, input) => {
      expect(findStepPositionProblem(input, VIEWER)).toBeNull();
    });

    it("leaves a repeat step's for clause to its template", () => {
      const clause = { $ref: '$arguments', path: 'items', as: 'item' };
      const repeat = (template: unknown) => ({ for: clause, template });
      expect(
        findStepPositionProblem(repeat({ input: { image: ref() } }), VIEWER, undefined, 'repeat')
      ).toBeNull();
      expect(
        findStepPositionProblem(repeat({ input: { model: ref() } }), VIEWER, undefined, 'repeat')
      ).toMatchObject({ form: 'reference', key: 'model' });
      // A repeat nested in another step's template is exempt the same way.
      expect(
        findStepPositionProblem(
          { template: { $type: 'repeat', input: repeat({ input: { image: ref() } }) } },
          VIEWER,
          undefined,
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

    it('lets a blob through at a media key', () => {
      expect(
        findStepPositionProblem({ trainingData: { type: 'blobs', items: [{ air: blob }] } }, VIEWER)
      ).toBeNull();
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

describe('media keys', () => {
  it("are the prompt audit's list, plus trainingData", () => {
    for (const key of ['blob', 'frames', 'keyframes', 'url', 'sampleInputImages']) {
      expect(STEP_MEDIA_INPUT_KEYS.has(key.toLowerCase())).toBe(true);
      expect(findStepPositionProblem({ [key]: ref() }, VIEWER)).toBeNull();
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
