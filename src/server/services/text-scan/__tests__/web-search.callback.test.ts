import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as Adapters from '~/server/services/moderation-adapters';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// @civitai/orchestration-client is mocked globally in src/__tests__/setup.ts (getWorkflow is a vi.fn()).
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
  getTextScanWebSearchMode: vi.fn(),
}));
vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  getModerationAdapter: vi.fn(),
}));

const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { getWorkflow } = await import('@civitai/orchestration-client');
const { getTextScanMode, getTextScanWebSearchMode } = await import(
  '~/server/services/text-scan/mode'
);
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');

const load = vi.fn();
registerTextScanProfile({ entityType: 'Model', labels: ['nsfw', 'poi', 'minor'], load });
const adapter = { resolveContent: vi.fn(), submit: vi.fn(), applyTextScan: vi.fn() };
const updateMany = dbMock.dbWrite.entityModeration.updateMany;

const searchMeta = (mode: 'shadow' | 'active') => ({
  entityType: 'Model',
  entityId: 7,
  emEntityType: mode === 'shadow' ? 'Model:search-shadow' : 'Model:search',
  mode,
  variant: 'web-search',
  externalId: 'ts-marker',
  labels: ['poi', 'minor'],
  promptIds: { base: 1, poi: 3, minor: 4 },
  model: 'air:test',
});
const mainMeta = {
  entityType: 'Model',
  entityId: 7,
  emEntityType: 'Model',
  mode: 'active',
  externalId: 'ts-main',
  labels: ['nsfw', 'poi', 'minor'],
  promptIds: { base: 1, nsfw: 2, poi: 3, minor: 4 },
  model: 'air:test',
};
const FLAGGED = {
  poi: { detected: true, names: ['Someone'], reason: 'r' },
  minor: { detected: true, reason: 'r' },
};
const workflow = (meta: Record<string, unknown>, parsed: unknown = FLAGGED) => ({
  data: {
    metadata: meta,
    tags: ['text-scan', 'Model', meta.mode],
    steps: [
      {
        $type: 'chatCompletion',
        output: {
          choices: [{ message: { content: JSON.stringify(parsed) }, finishReason: 'stop' }],
          parsed,
        },
      },
    ],
  },
});
const verdicts = () =>
  vi
    .mocked(loggingMock.logToAxiom)
    .mock.calls.map(([e]) => e as Record<string, unknown>)
    .filter((e) => e.name === 'scan-verdict');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getModerationAdapter).mockReturnValue(adapter as any);
  vi.mocked(getTextScanMode).mockResolvedValue('active');
  vi.mocked(getTextScanWebSearchMode).mockResolvedValue('active');
  load.mockResolvedValue(
    new Map([[7, { fields: [], declared: { nsfwLevel: 1, poi: false, minor: false } }]])
  );
  updateMany.mockResolvedValue({ count: 1 });
});

describe('handleTextScanCallback — web-search pass', () => {
  it('shadow: records on its own row, logs the verdict as web-search, and never acts', async () => {
    vi.mocked(getTextScanWebSearchMode).mockResolvedValue('shadow');
    vi.mocked(getWorkflow).mockResolvedValue(workflow(searchMeta('shadow')) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      entityType: 'Model:search-shadow',
      entityId: 7,
    });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'Succeeded',
      triggeredLabels: ['poi', 'minor'],
      nsfwLevel: null,
    });
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(verdicts()).toEqual([
      expect.objectContaining({
        entityType: 'Model',
        mode: 'shadow',
        variant: 'web-search',
        flagged: true,
        acted: false,
        poi: true,
        minor: true,
      }),
    ]);
  });

  it('active: applies only poi/minor, never an nsfw verdict', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(workflow(searchMeta('active')) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

    expect(updateMany.mock.calls[0][0].where).toMatchObject({ entityType: 'Model:search' });
    const [{ outcome }] = adapter.applyTextScan.mock.calls[0];
    expect(outcome.poi.newlyDetected).toBe(true);
    expect(outcome.minor.newlyDetected).toBe(true);
    expect(outcome.nsfw).toBeUndefined();
    expect(verdicts()).toEqual([
      expect.objectContaining({ mode: 'active', variant: 'web-search', acted: true }),
    ]);
  });

  it('active: does nothing once the main scan has left active', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('shadow');
    vi.mocked(getTextScanWebSearchMode).mockResolvedValue('shadow');
    vi.mocked(getWorkflow).mockResolvedValue(workflow(searchMeta('active')) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).not.toHaveBeenCalled();
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
  });

  it('active: still acts after only the search rollout has left active', async () => {
    vi.mocked(getTextScanWebSearchMode).mockResolvedValue('shadow');
    vi.mocked(getWorkflow).mockResolvedValue(workflow(searchMeta('active')) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(adapter.applyTextScan).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ entityType: 'Model:search' });
    const [{ outcome }] = adapter.applyTextScan.mock.calls[0];
    expect(outcome.poi.newlyDetected).toBe(true);
  });

  it('main active pass submitted with poi/minor still acts on them after the search pass went active', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow(mainMeta, { nsfw: { level: 'x', reason: 'r' }, ...FLAGGED }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

    expect(updateMany.mock.calls[0][0].data.triggeredLabels).toEqual(['nsfw', 'poi', 'minor']);
    const [{ outcome }] = adapter.applyTextScan.mock.calls[0];
    expect(outcome.nsfw.raised).toBe(true);
    expect(outcome.poi.newlyDetected).toBe(true);
    expect(outcome.minor.newlyDetected).toBe(true);
  });

  it('main active pass applies poi/minor itself while the search pass is not active', async () => {
    vi.mocked(getTextScanWebSearchMode).mockResolvedValue('shadow');
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow(mainMeta, { nsfw: { level: 'none', reason: 'r' }, ...FLAGGED }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    const [{ outcome }] = adapter.applyTextScan.mock.calls[0];
    expect(outcome.poi.newlyDetected).toBe(true);
  });

  it.each([
    ['submitted with poi/minor', mainMeta, 'nsfw,poi,minor'],
    [
      'submitted without poi/minor',
      { ...mainMeta, labels: ['nsfw'], promptIds: { base: 1, nsfw: 2 } },
      'nsfw',
    ],
  ])(
    'main active pass %s: the verdict log lists only the labels it acted on',
    async (_, meta, tags) => {
      vi.mocked(getWorkflow).mockResolvedValue(
        workflow(meta, { nsfw: { level: 'x', reason: 'r' }, ...FLAGGED }) as any
      );
      await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
      const [{ outcome }] = adapter.applyTextScan.mock.calls[0];
      const [verdict] = verdicts();
      expect(verdict.tags).toBe(tags);
      expect(verdict.acted).toBe(true);
      expect(verdict.poi).toBe(outcome.poi?.detected);
      expect(verdict.minor).toBe(outcome.minor?.detected);
    }
  );

  it('ignores a web-search workflow whose row key or entity type does not fit', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ ...searchMeta('active'), emEntityType: 'Model' }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ ...searchMeta('active'), variant: 'other', emEntityType: 'Model' }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-2', status: 'succeeded' });
    expect(updateMany).not.toHaveBeenCalled();
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
  });

  it('writes a failed search scan to its own row without calling applyFailure', async () => {
    const applyFailure = vi.fn();
    vi.mocked(getModerationAdapter).mockReturnValue({ ...adapter, applyFailure } as any);
    vi.mocked(getWorkflow).mockResolvedValue({
      data: { metadata: searchMeta('active'), tags: ['text-scan'], steps: [] },
    } as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'failed' });
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { entityType: 'Model:search', entityId: 7 },
      data: { status: 'Failed' },
    });
    expect(applyFailure).not.toHaveBeenCalled();
  });
  describe('segmented workflows', () => {
    const step = (segment: number, parsed: unknown) => ({
      $type: 'chatCompletion',
      name: segment === 0 ? 'textScan' : `textScan${segment}`,
      metadata: { segment },
      output: {
        choices: [{ message: { content: JSON.stringify(parsed) }, finishReason: 'stop' }],
        parsed,
      },
    });
    const CLEAN = {
      poi: { detected: false, names: [], reason: 'r' },
      minor: { detected: false, reason: 'r' },
    };
    const segmented = (
      meta: Record<string, unknown>,
      outputs: unknown[],
      segments = outputs.length
    ) => ({
      data: {
        metadata: { ...meta, segments, inputChars: 3000, inputCut: false, scannedChars: 3000 },
        tags: ['text-scan', 'Model', meta.mode, 'web-search'],
        steps: outputs.map((parsed, i) => step(i, parsed)),
      },
    });

    it('active search pass: a flag in any segment applies poi/minor', async () => {
      vi.mocked(getWorkflow).mockResolvedValue(
        segmented(searchMeta('active'), [CLEAN, FLAGGED, CLEAN]) as any
      );
      await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
      expect(updateMany.mock.calls[0][0].where).toMatchObject({ entityType: 'Model:search' });
      const [{ outcome }] = adapter.applyTextScan.mock.calls[0];
      expect(outcome.poi.newlyDetected).toBe(true);
      expect(outcome.minor.newlyDetected).toBe(true);
    });

    it('active search pass: a missing segment fails closed without applyFailure', async () => {
      const applyFailure = vi.fn();
      vi.mocked(getModerationAdapter).mockReturnValue({ ...adapter, applyFailure } as any);
      vi.mocked(getWorkflow).mockResolvedValue(
        segmented(searchMeta('active'), [FLAGGED, CLEAN], 3) as any
      );
      await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
      expect(updateMany.mock.calls[0][0]).toMatchObject({
        where: { entityType: 'Model:search', entityId: 7 },
        data: { status: 'Failed' },
      });
      expect(adapter.applyTextScan).not.toHaveBeenCalled();
      expect(applyFailure).not.toHaveBeenCalled();
    });

    it('main active pass: acts on the labels it was submitted with, from any segment', async () => {
      const none = { nsfw: { level: 'none', reason: 'r' }, ...CLEAN };
      vi.mocked(getWorkflow).mockResolvedValue(
        segmented(mainMeta, [none, { nsfw: { level: 'x', reason: 'r' }, ...FLAGGED }]) as any
      );
      await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
      const [{ outcome }] = adapter.applyTextScan.mock.calls[0];
      expect(outcome.nsfw.raised).toBe(true);
      expect(outcome.triggeredLabels).toEqual(['nsfw', 'poi', 'minor']);
    });
  });
});

describe('handleTextScanCallback — a partial verdict with the search pass', () => {
  const findUnique = dbMock.dbWrite.entityModeration.findUnique;
  const NONE = {
    nsfw: { level: 'none', reason: 'c' },
    poi: { detected: false, names: [], reason: 'c' },
    minor: { detected: false, reason: 'c' },
  };
  const partial = (meta: Record<string, unknown>, first: Record<string, unknown>) => ({
    data: {
      metadata: { ...meta, segments: 2 },
      tags: ['text-scan', 'Model', meta.mode],
      steps: [
        {
          $type: 'chatCompletion',
          name: 'textScan',
          metadata: { segment: 0 },
          output: {
            choices: [{ message: { content: JSON.stringify(first) }, finishReason: 'stop' }],
            parsed: first,
          },
        },
        {
          $type: 'chatCompletion',
          name: 'textScan1',
          metadata: { segment: 1 },
          output: { choices: [{ message: { content: 'not json' }, finishReason: 'stop' }] },
        },
      ],
    },
  });
  beforeEach(() => {
    findUnique.mockResolvedValue({
      workflowId: 'wf-1',
      nsfwLevel: 1,
      triggeredLabels: [],
      result: { version: 1, labels: NONE },
    } as any);
  });

  it('a main pass submitted with poi/minor raises and acts on them after the search pass went active', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(partial(mainMeta, { ...NONE, ...FLAGGED }) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany.mock.calls[1][0].data).toMatchObject({ triggeredLabels: ['poi', 'minor'] });
    const [{ outcome }] = adapter.applyTextScan.mock.calls[0];
    expect(outcome.triggeredLabels).toEqual(['poi', 'minor']);
  });

  it('the active search pass acts on its own partial poi/minor', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      partial(searchMeta('active'), { poi: NONE.poi, minor: FLAGGED.minor }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany.mock.calls[1][0].where).toMatchObject({ entityType: 'Model:search' });
    const [{ outcome }] = adapter.applyTextScan.mock.calls[0];
    expect(outcome.triggeredLabels).toEqual(['minor']);
  });

  it('an active search pass still acts on its partial poi/minor after the search rollout stepped back', async () => {
    vi.mocked(getTextScanWebSearchMode).mockResolvedValue('shadow');
    vi.mocked(getWorkflow).mockResolvedValue(
      partial(searchMeta('active'), { poi: NONE.poi, minor: FLAGGED.minor }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany.mock.calls[1][0].where).toMatchObject({ entityType: 'Model:search' });
    expect(adapter.applyTextScan).toHaveBeenCalledTimes(1);
    const [{ outcome }] = adapter.applyTextScan.mock.calls[0];
    expect(outcome.triggeredLabels).toEqual(['minor']);
  });
});
