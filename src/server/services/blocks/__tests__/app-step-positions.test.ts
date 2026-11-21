import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptModule from '~/server/flipt/client';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import {
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

// Deliberate: media inputs may take references, URLs and orchestrator files, and every other key
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

    it("leaves a repeat's for clause to its template", () => {
      expect(
        findStepPositionProblem(
          {
            for: { $ref: '$arguments', path: 'items', as: 'item' },
            template: { input: { image: ref() } },
          },
          VIEWER
        )
      ).toBeNull();
      expect(
        findStepPositionProblem(
          {
            for: { $ref: '$arguments', path: 'items', as: 'item' },
            template: { input: { model: ref() } },
          },
          VIEWER
        )
      ).toMatchObject({ form: 'reference', key: 'model' });
    });
  });

  describe("references to the request's own arguments", () => {
    const args = {
      strength: 0.4,
      lora: blob,
      weights: 'https://bucket.abc.r2.cloudflarestorage.com/models/123/file',
      nested: { list: ['a cat'] },
    };

    it('checks the value an argument places, where it lands', () => {
      expect(
        findStepPositionProblem({ strength: ref({ path: 'strength' }) }, VIEWER, args)
      ).toBeNull();
      expect(
        findStepPositionProblem({ prompt: ref({ path: 'nested.list[0]' }) }, VIEWER, args)
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
        form: 'reference',
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
