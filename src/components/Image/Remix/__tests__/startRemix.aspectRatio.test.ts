import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GenerationGraphStore from '~/store/generation-graph.store';
import { generationGraph } from '~/shared/data-graph/generation/generation-graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

const setData = vi.fn();
const fetchGenerationData = vi.fn();

vi.mock('~/store/generation-graph.store', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationGraphStore>()),
  generationGraphPanel: { open: vi.fn() },
  generationGraphStore: { setData },
  fetchGenerationData: (...args: unknown[]) => fetchGenerationData(...args),
  withExternalFetch: async <T>(run: () => Promise<T>) => ({
    result: await run(),
    superseded: false,
  }),
}));

const { startRemix } = await import('../remix.utils');

const SOURCE = { width: 832, height: 1216 };

function image(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    url: 'abc-123',
    type: MediaType.image,
    ingestion: ImageIngestionStatus.Scanned,
    ...SOURCE,
    ...overrides,
  } as Parameters<typeof startRemix>[0]['image'];
}

beforeEach(() => {
  setData.mockClear();
  fetchGenerationData.mockReset().mockResolvedValue({ params: {}, resources: [] });
});

describe('startRemix seeds the source image ratio', () => {
  // `data.params` describes the engine's model version, so without an explicit
  // aspectRatio the form falls back to the node default and the user pays for a
  // square generation of a portrait source.
  it.each([
    ['a safe image', 1],
    ['a mature image', 4],
  ])('%s', async (_label, nsfwLevel) => {
    await startRemix({ kind: 'edit', image: image({ nsfwLevel }) });

    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData.mock.calls[0][0].params.aspectRatio).toEqual({
      value: '832:1216',
      ...SOURCE,
    });
  });
});

describe('the seeded ratio survives the generation graph', () => {
  const ext: GenerationCtx = {
    limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
    user: { isMember: true, tier: 'gold' },
    gateRules: [],
  };

  // Qwen is the mature tier's edit engine and the only remix engine whose graph
  // has an aspectRatio node, so it is the one that could silently resolve back
  // to 1:1. Its handler passes these dimensions straight to the orchestrator.
  it('lands a portrait bucket on the Qwen edit graph, not 1:1', async () => {
    await startRemix({ kind: 'edit', image: image({ nsfwLevel: 4 }) });
    const { params } = setData.mock.calls[0][0];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const graph = generationGraph as any;
    graph.init({ workflow: params.workflow, ecosystem: params.ecosystem }, ext);
    graph.set(params);

    const { aspectRatio } = graph.getSnapshot();
    expect(aspectRatio).toMatchObject(SOURCE);
    expect(aspectRatio.value).not.toBe('1:1');
  });
});
