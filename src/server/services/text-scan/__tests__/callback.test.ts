import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as Adapters from '~/server/services/moderation-adapters';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// @civitai/client is mocked globally in src/__tests__/setup.ts (getWorkflow is a vi.fn()).
vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
}));
vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  getModerationAdapter: vi.fn(),
}));

const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { getWorkflow } = await import('@civitai/client');
const { getTextScanMode } = await import('~/server/services/text-scan/mode');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');

const load = vi.fn();
registerTextScanProfile({ entityType: 'Post', labels: ['nsfw'], load });
const adapter = {
  resolveContent: vi.fn(),
  submit: vi.fn(),
  applyTextScan: vi.fn(),
  applyFailure: vi.fn(),
};
const updateMany = dbMock.dbWrite.entityModeration.updateMany;

const MARKER = 'ts-Post-7-abc-0-0';
const metadata = {
  entityType: 'Post',
  entityId: 7,
  emEntityType: 'Post',
  mode: 'active',
  externalId: MARKER,
  labels: ['nsfw'],
  promptIds: { base: 1, nsfw: 2 },
  model: 'air:test',
  thinking: false,
};
const shadowMetadata = {
  ...metadata,
  emEntityType: 'Post:shadow',
  mode: 'shadow',
  externalId: 'ts-Post_shadow-7-abc-0-0',
};
const TAGS = ['text-scan', 'Post', 'active'];
const workflow = (
  parsed: unknown,
  content = JSON.stringify(parsed),
  meta: Record<string, unknown> = metadata
) => ({
  data: {
    metadata: meta,
    tags: TAGS,
    steps: [
      {
        $type: 'chatCompletion',
        output: { choices: [{ message: { content }, finishReason: 'stop' }], parsed },
      },
    ],
  },
});
const failed = (meta: Record<string, unknown> = metadata) => ({
  data: { metadata: meta, tags: TAGS, steps: [] },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getModerationAdapter).mockReturnValue(adapter as any);
  vi.mocked(getTextScanMode).mockResolvedValue('active');
  load.mockResolvedValue(new Map([[7, { fields: [], declared: { nsfwLevel: 1 } }]]));
  updateMany.mockResolvedValue({ count: 1 });
});

describe('handleTextScanCallback', () => {
  it('records the verdict, matching the marker too, and applies it when active', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'Explicit.' } }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

    const { where, data } = vi.mocked(updateMany).mock.calls[0][0];
    expect(where).toEqual({
      entityType: 'Post',
      entityId: 7,
      workflowId: { in: ['wf-1', MARKER] },
    });
    expect(data).toMatchObject({
      workflowId: 'wf-1',
      status: 'Succeeded',
      triggeredLabels: ['nsfw'],
      nsfwLevel: 8,
    });
    expect(data.result).toMatchObject({
      version: 1,
      promptIds: { base: 1, nsfw: 2 },
      model: 'air:test',
    });
    expect(adapter.applyTextScan).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 7,
        workflowId: 'wf-1',
        outcome: expect.objectContaining({ nsfwLevel: 8 }),
      })
    );
  });

  it('records result.meta from the metadata captured at submit, not from the reloaded subject', async () => {
    load.mockResolvedValue(
      new Map([[7, { fields: [], declared: { nsfwLevel: 1 }, meta: { messageIds: [9] } }]])
    );
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'r' } }, undefined, {
        ...metadata,
        subjectMeta: { messageIds: [5, 4] },
      }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(vi.mocked(updateMany).mock.calls[0][0].data.result).toMatchObject({
      meta: { messageIds: [5, 4] },
    });

    vi.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'r' } }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(vi.mocked(updateMany).mock.calls[0][0].data.result).toMatchObject({
      meta: { messageIds: [9] },
    });
  });

  it('records result.textHash from the metadata captured at submit', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'r' } }, undefined, {
        ...metadata,
        textHash: 'submitted-hash',
      }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(vi.mocked(updateMany).mock.calls[0][0].data.result).toMatchObject({
      textHash: 'submitted-hash',
    });
  });

  it.each(['shadow', 'off'] as const)(
    'writes nothing to the live row and acts on nothing when an active scan lands in %s mode',
    async (mode) => {
      vi.mocked(getTextScanMode).mockResolvedValue(mode);
      vi.mocked(getWorkflow).mockResolvedValue(
        workflow({ nsfw: { level: 'x', reason: 'r' } }) as any
      );
      await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
      expect(updateMany).not.toHaveBeenCalled();
      expect(adapter.applyTextScan).not.toHaveBeenCalled();

      vi.mocked(getWorkflow).mockResolvedValue(failed() as any);
      await handleTextScanCallback({ workflowId: 'wf-1', status: 'failed' });
      expect(updateMany).not.toHaveBeenCalled();
      expect(adapter.applyFailure).not.toHaveBeenCalled();
    }
  );

  it('records a shadow scan on the shadow row and calls no hook, even if the flag is now active', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'r' } }, undefined, shadowMetadata) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(vi.mocked(updateMany).mock.calls[0][0].where).toEqual({
      entityType: 'Post:shadow',
      entityId: 7,
      workflowId: { in: ['wf-1', shadowMetadata.externalId] },
    });
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
  });

  it('writes a failed shadow scan to the shadow row without calling applyFailure', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(failed(shadowMetadata) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'failed' });
    expect(vi.mocked(updateMany).mock.calls[0][0]).toMatchObject({
      where: { entityType: 'Post:shadow', entityId: 7 },
      data: { status: 'Failed', workflowId: 'wf-1', retryCount: { increment: 1 } },
    });
    expect(adapter.applyFailure).not.toHaveBeenCalled();
  });

  it('ignores a stale callback', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'r' } }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-old', status: 'succeeded' });
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
  });

  it('turns an unusable output into a Failed row, logs the reason, and takes no action', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow(undefined, "I'm sorry, I can't do that.") as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMany).mock.calls[0][0]).toMatchObject({
      where: { entityType: 'Post', entityId: 7, workflowId: { in: ['wf-1', MARKER] } },
      data: { status: 'Failed', workflowId: 'wf-1' },
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'text-scan', reason: 'refused' })
    );
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(adapter.applyFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('evaluates against the declared state at callback time', async () => {
    load.mockResolvedValue(new Map([[7, { fields: [], declared: { nsfwLevel: 8 } }]]));
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'r' } }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(vi.mocked(updateMany).mock.calls[0][0].data.triggeredLabels).toEqual([]);
  });

  it.each([
    ['failed', 'Failed'],
    ['expired', 'Expired'],
    ['canceled', 'Canceled'],
  ])('maps %s to an EM %s row', async (status, emStatus) => {
    vi.mocked(getWorkflow).mockResolvedValue(failed() as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status });
    expect(vi.mocked(updateMany).mock.calls[0][0].data).toMatchObject({ status: emStatus });
    expect(adapter.applyFailure).toHaveBeenCalledWith(expect.objectContaining({ status }));
  });

  it.each([
    [
      'an XGuard workflow (no text-scan tag)',
      { metadata: { entityType: 'Post', entityId: 7, mode: 'text' }, tags: ['xguard'], steps: [] },
    ],
    [
      'a tagged workflow without metadata.mode',
      { metadata: { entityType: 'Post', entityId: 7 }, tags: TAGS, steps: [] },
    ],
    ['a workflow without an entity', { metadata: { mode: 'active' }, tags: TAGS, steps: [] }],
    [
      'an unknown entity type',
      { metadata: { ...metadata, entityType: 'Collection' }, tags: TAGS, steps: [] },
    ],
  ])('ignores %s without writing or throwing', async (_name, data) => {
    vi.mocked(getWorkflow).mockResolvedValue({ data } as any);
    await expect(
      handleTextScanCallback({ workflowId: 'wf-1', status: 'failed' })
    ).resolves.toBeUndefined();
    expect(updateMany).not.toHaveBeenCalled();
    expect(adapter.applyFailure).not.toHaveBeenCalled();
  });
});
