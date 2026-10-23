import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import type * as ModeModule from '~/server/services/text-scan/mode';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// @civitai/orchestration-client is mocked globally in src/__tests__/setup.ts (submitWorkflow is a vi.fn()).
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
  getTextScanWebSearchMode: vi.fn(),
}));
vi.mock('~/server/services/text-scan/prompt', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptModule>()),
  getActiveTextScanPrompts: vi.fn(),
  getTextScanConfig: vi.fn(),
}));

const { scanEntity } = await import('~/server/services/text-scan/submit');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { submitWorkflow } = await import('@civitai/orchestration-client');
const { getTextScanMode, getTextScanWebSearchMode } = await import(
  '~/server/services/text-scan/mode'
);
const { getActiveTextScanPrompts, getTextScanConfig } = await import(
  '~/server/services/text-scan/prompt'
);

const PROMPTS = {
  base: { id: 1, key: 'base', content: 'BASE' },
  'label:nsfw': { id: 2, key: 'label:nsfw', content: 'NSFW' },
  'label:poi': { id: 3, key: 'label:poi', content: 'POI' },
  'label:minor': { id: 4, key: 'label:minor', content: 'MINOR' },
};
const load = vi.fn();
registerTextScanProfile({ entityType: 'Model', labels: ['nsfw', 'poi', 'minor'], load });

const em = dbMock.dbWrite.entityModeration;
type Body = {
  metadata: Record<string, any>;
  tags: string[];
  steps: { name: string; metadata?: Record<string, any>; input: Record<string, any> }[];
};
const bodies = () =>
  vi.mocked(submitWorkflow).mock.calls.map(([args]) => args.body as unknown as Body);
const submittedRow = (i: number) => vi.mocked(em.upsert).mock.calls[i][0].where;

function modes(main: 'off' | 'shadow' | 'active', search: 'off' | 'shadow' | 'active') {
  vi.mocked(getTextScanMode).mockResolvedValue(main);
  vi.mocked(getTextScanWebSearchMode).mockResolvedValue(search);
}

beforeEach(() => {
  vi.clearAllMocks();
  modes('active', 'off');
  vi.mocked(getActiveTextScanPrompts).mockResolvedValue(PROMPTS);
  vi.mocked(getTextScanConfig).mockResolvedValue({
    model: 'air:test',
    maxInputChars: 1000,
    thinking: false,
  });
  load.mockResolvedValue(
    new Map([[7, { fields: [{ heading: 'Name', text: 'Some model' }], declared: {} }]])
  );
  em.findUnique.mockResolvedValue(null);
  em.upsert.mockResolvedValue({} as any);
  em.updateMany.mockResolvedValue({ count: 1 });
  let n = 0;
  vi.mocked(submitWorkflow).mockImplementation(async () => ({ data: { id: `wf-${++n}` } } as any));
});

describe('scanEntity with the web-search pass', () => {
  it('submits only the main pass, unchanged, while the search mode is off', async () => {
    expect(await scanEntity({ entityType: 'Model', entityId: 7 })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    const [body] = bodies();
    expect(bodies()).toHaveLength(1);
    expect(body.metadata.labels).toEqual(['nsfw', 'poi', 'minor']);
    expect(body.metadata).not.toHaveProperty('variant');
    expect(body.steps[0].input).not.toHaveProperty('tools');
    expect(body.tags).toEqual(['text-scan', 'Model', 'active']);
    expect(getTextScanWebSearchMode).toHaveBeenCalledWith('Model', 7, 'active');
  });

  it('shadow: keeps the main pass whole and adds a poi+minor search pass on its own row', async () => {
    modes('shadow', 'shadow');
    expect(await scanEntity({ entityType: 'Model', entityId: 7 })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    const [main, search] = bodies();
    expect(main.metadata).toMatchObject({
      emEntityType: 'Model:shadow',
      labels: ['nsfw', 'poi', 'minor'],
    });
    expect(main.steps[0].input).not.toHaveProperty('tools');
    expect(search.metadata).toMatchObject({
      emEntityType: 'Model:search-shadow',
      mode: 'shadow',
      variant: 'web-search',
      labels: ['poi', 'minor'],
      promptIds: { base: 1, poi: 3, minor: 4 },
    });
    expect(search.steps[0].input.tools).toEqual([{ type: 'civitai:web_search' }]);
    expect(search.tags).toEqual(['text-scan', 'Model', 'shadow', 'web-search']);
    expect(search.steps[0].input.messages[0].content).not.toContain('NSFW');
    expect(submittedRow(1)).toEqual({
      entityType_entityId: { entityType: 'Model:search-shadow', entityId: 7 },
    });
  });

  it('active: moves poi+minor off the main pass and onto the search pass', async () => {
    modes('active', 'active');
    await scanEntity({ entityType: 'Model', entityId: 7 });
    const [main, search] = bodies();
    expect(main.metadata).toMatchObject({ emEntityType: 'Model', labels: ['nsfw'] });
    expect(main.metadata.promptIds).toEqual({ base: 1, nsfw: 2 });
    expect(search.metadata).toMatchObject({
      emEntityType: 'Model:search',
      mode: 'active',
      labels: ['poi', 'minor'],
    });
  });

  it('main active, search shadow: the main pass keeps poi+minor', async () => {
    modes('active', 'shadow');
    await scanEntity({ entityType: 'Model', entityId: 7 });
    const [main, search] = bodies();
    expect(main.metadata).toMatchObject({
      emEntityType: 'Model',
      labels: ['nsfw', 'poi', 'minor'],
    });
    expect(search.metadata.emEntityType).toBe('Model:search-shadow');
  });

  it('runs one pass when asked for it', async () => {
    modes('active', 'active');
    expect(await scanEntity({ entityType: 'Model', entityId: 7, pass: 'web-search' })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    expect(bodies().map((b) => b.metadata.emEntityType)).toEqual(['Model:search']);
    vi.mocked(submitWorkflow).mockClear();
    await scanEntity({ entityType: 'Model', entityId: 7, pass: 'main' });
    expect(bodies().map((b) => b.metadata.emEntityType)).toEqual(['Model']);
  });

  it('is off for the search pass alone when its mode is off', async () => {
    expect(await scanEntity({ entityType: 'Model', entityId: 7, pass: 'web-search' })).toEqual({
      status: 'skipped',
      reason: 'off',
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('dedupes the search pass against its own row only', async () => {
    modes('shadow', 'shadow');
    await scanEntity({ entityType: 'Model', entityId: 7 });
    const searchHash = vi.mocked(em.upsert).mock.calls[1][0].update.contentHash;
    const mainHash = vi.mocked(em.upsert).mock.calls[0][0].update.contentHash;
    expect(searchHash).not.toBe(mainHash);
    vi.clearAllMocks();
    em.findUnique.mockImplementation((async ({ where }: any) =>
      where.entityType_entityId.entityType === 'Model:search-shadow'
        ? {
            status: 'Succeeded',
            contentHash: searchHash,
            workflowId: 'wf-s',
            retryCount: 0,
            updatedAt: new Date(),
          }
        : null) as any);
    vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'wf-9' } } as any);
    await scanEntity({ entityType: 'Model', entityId: 7 });
    expect(bodies().map((b) => b.metadata.emEntityType)).toEqual(['Model:shadow']);
  });

  it('a search-rollout flip either way rescans unchanged text on the main row', async () => {
    const mainHash = async (search: 'shadow' | 'active') => {
      modes('active', search);
      em.findUnique.mockResolvedValue(null);
      vi.mocked(em.upsert).mockClear();
      await scanEntity({ entityType: 'Model', entityId: 7 });
      return vi.mocked(em.upsert).mock.calls[0][0].update.contentHash;
    };
    const succeededAt = (contentHash: string) =>
      em.findUnique.mockImplementation((async ({ where }: any) =>
        where.entityType_entityId.entityType === 'Model'
          ? {
              status: 'Succeeded',
              contentHash,
              workflowId: 'wf-m',
              retryCount: 0,
              updatedAt: new Date(),
            }
          : null) as any);
    const [whole, split] = [await mainHash('shadow'), await mainHash('active')];

    for (const [stored, search] of [
      [whole, 'active'],
      [split, 'shadow'],
    ] as const) {
      modes('active', search);
      succeededAt(stored);
      vi.mocked(submitWorkflow).mockClear();
      await scanEntity({ entityType: 'Model', entityId: 7 });
      expect(bodies()[0].metadata.emEntityType).toBe('Model');
    }
  });

  it('a main-row retry does not bypass the in-flight window of the search pass', async () => {
    modes('shadow', 'shadow');
    await scanEntity({ entityType: 'Model', entityId: 7 });
    const searchHash = vi.mocked(em.upsert).mock.calls[1][0].update.contentHash;
    vi.clearAllMocks();
    em.findUnique.mockImplementation((async ({ where }: any) =>
      where.entityType_entityId.entityType === 'Model:search-shadow'
        ? {
            status: 'Pending',
            contentHash: searchHash,
            workflowId: 'wf-s',
            retryCount: 0,
            updatedAt: new Date(),
          }
        : null) as any);
    vi.mocked(submitWorkflow).mockResolvedValue({ data: { id: 'wf-9' } } as any);
    await scanEntity({ entityType: 'Model', entityId: 7, fromRetry: true });
    expect(bodies().map((b) => b.metadata.emEntityType)).toEqual(['Model:shadow']);
    vi.mocked(submitWorkflow).mockClear();
    await scanEntity({ entityType: 'Model', entityId: 7, fromRetry: true, pass: 'web-search' });
    expect(bodies().map((b) => b.metadata.emEntityType)).toEqual(['Model:search-shadow']);
  });

  it('a failing search pass does not change the main result', async () => {
    modes('shadow', 'shadow');
    em.upsert.mockResolvedValueOnce({} as any).mockRejectedValueOnce(new Error('db down'));
    expect(await scanEntity({ entityType: 'Model', entityId: 7 })).toEqual({
      status: 'submitted',
      workflowId: 'wf-1',
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'web-search pass threw', entityId: 7 })
    );
  });

  it('clears a stale search verdict on its own row when the text drops below minChars', async () => {
    modes('shadow', 'shadow');
    load.mockResolvedValue(
      new Map([[7, { fields: [{ heading: 'Name', text: '' }], declared: {} }]])
    );
    await scanEntity({ entityType: 'Model', entityId: 7 });
    const keys = vi
      .mocked(em.findUnique)
      .mock.calls.map(([args]) => (args.where as any).entityType_entityId.entityType);
    expect(keys).toEqual(['Model:shadow', 'Model:search-shadow']);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });
  it("clears composed-to-nothing text on the asked pass's row only", async () => {
    modes('shadow', 'shadow');
    registerTextScanProfile({
      entityType: 'Model',
      labels: ['nsfw', 'poi', 'minor'],
      minChars: 0,
      load,
    });
    try {
      load.mockResolvedValue(
        new Map([[7, { fields: [{ heading: 'Name', text: '  ' }], declared: {} }]])
      );
      em.findUnique.mockResolvedValue({
        workflowId: 'wf-9',
        status: 'Succeeded',
        nsfwLevel: 1,
        triggeredLabels: ['minor'],
        result: { version: 1 },
      } as any);
      const cleared = () =>
        vi.mocked(em.updateMany).mock.calls.map(([args]) => (args.where as any).entityType);

      await scanEntity({ entityType: 'Model', entityId: 7, pass: 'web-search' });
      expect(cleared()).toEqual(['Model:search-shadow']);
      vi.mocked(em.updateMany).mockClear();
      await scanEntity({ entityType: 'Model', entityId: 7, pass: 'main' });
      expect(cleared()).toEqual(['Model:shadow']);
      expect(submitWorkflow).not.toHaveBeenCalled();
    } finally {
      registerTextScanProfile({ entityType: 'Model', labels: ['nsfw', 'poi', 'minor'], load });
    }
  });

  it('segments both passes alike; only the search steps carry the tool', async () => {
    modes('active', 'active');
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    load.mockResolvedValue(
      new Map([[7, { fields: [{ heading: 'Body', text: long }], declared: {} }]])
    );
    await scanEntity({ entityType: 'Model', entityId: 7 });
    const [main, search] = bodies();
    expect(main.steps.length).toBeGreaterThan(1);
    expect(search.steps.map((s) => s.input.messages[1].content)).toEqual(
      main.steps.map((s) => s.input.messages[1].content)
    );
    expect(search.steps.map((s) => s.metadata)).toEqual(main.steps.map((s) => s.metadata));
    expect(search.metadata.segments).toBe(search.steps.length);
    expect(main.metadata.segments).toBe(main.steps.length);
    expect(search.steps.every((s) => s.input.tools?.[0]?.type === 'civitai:web_search')).toBe(true);
    expect(main.steps.some((s) => 'tools' in s.input)).toBe(false);
  });

  it('a one-segment search pass submits the single unsegmented step', async () => {
    modes('active', 'active');
    await scanEntity({ entityType: 'Model', entityId: 7 });
    const [, search] = bodies();
    expect(search.steps).toHaveLength(1);
    expect(search.steps[0].name).toBe('textScan');
    expect(search.steps[0]).not.toHaveProperty('metadata');
    expect(search.steps[0].input.tools).toEqual([{ type: 'civitai:web_search' }]);
  });
});
