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
  getTextScanCsamMode: vi.fn(async () => 'off'),
}));
vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof Adapters>()),
  getModerationAdapter: vi.fn(),
}));

const { handleTextScanCallback } = await import('~/server/services/text-scan/callback');
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
const { getWorkflow } = await import('@civitai/orchestration-client');
const { getTextScanMode, getTextScanCsamMode } = await import('~/server/services/text-scan/mode');
await import('~/server/services/text-scan/profiles/chat-message.profile');
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
        promptIds: { base: 1, nsfw: 2 },
      })
    );
  });

  it('puts the row back up for retry, and rethrows, when applying the verdict fails', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'Explicit.' } }) as any
    );
    adapter.applyTextScan.mockRejectedValueOnce(new Error('db down'));

    await expect(
      handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' })
    ).rejects.toThrow('db down');

    const calls = vi.mocked(updateMany).mock.calls.map(([args]) => args);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      where: { entityType: 'Post', entityId: 7, workflowId: 'wf-1' },
      data: { workflowId: 'wf-1', status: 'Failed', retryCount: { increment: 1 } },
    });
  });

  it.each(['active', 'shadow'])(
    '%s: drops the verdict for a subject no longer public, leaving the row Failed',
    async (mode) => {
      load.mockResolvedValue(
        new Map([[7, { fields: [], declared: { nsfwLevel: 1 }, notPublic: true }]])
      );
      vi.mocked(getWorkflow).mockResolvedValue(
        workflow(
          { nsfw: { level: 'x', reason: 'Explicit.' } },
          undefined,
          mode === 'active' ? metadata : shadowMetadata
        ) as any
      );
      await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(vi.mocked(updateMany).mock.calls[0][0]).toEqual({
        where: {
          entityType: mode === 'active' ? 'Post' : 'Post:shadow',
          entityId: 7,
          workflowId: { in: ['wf-1', mode === 'active' ? MARKER : shadowMetadata.externalId] },
        },
        data: { workflowId: 'wf-1', status: 'Failed', retryCount: { increment: 1 } },
      });
      expect(adapter.applyTextScan).not.toHaveBeenCalled();
      expect(adapter.applyFailure).not.toHaveBeenCalled();
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'subject not public; verdict dropped', entityId: 7 })
      );
    }
  );

  // An edit between submit and callback must not move the hash a flag and its appeal grant compare.
  it('hands the action the text hash of the subject as submitted', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'Explicit.' } }, undefined, {
        ...metadata,
        textHash: 'submitted-hash',
      }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(adapter.applyTextScan).toHaveBeenCalledWith(
      expect.objectContaining({ textHash: 'submitted-hash' })
    );
  });

  it('falls back to the reloaded subject hash for a workflow submitted without one', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'Explicit.' } }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(adapter.applyTextScan).toHaveBeenCalledWith(
      expect.objectContaining({ textHash: textScanTextHash({ fields: [], declared: {} }) })
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

  it('adds inputChars and inputCut from the submit metadata to result.meta', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'r' } }, undefined, {
        ...metadata,
        subjectMeta: { messageIds: [5] },
        inputChars: 250000,
        inputCut: true,
      }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(vi.mocked(updateMany).mock.calls[0][0].data.result).toMatchObject({
      version: 1,
      meta: { messageIds: [5], inputChars: 250000, inputCut: true },
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
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'scan-verdict',
        system: 'text-scan',
        entityType: 'Post',
        entityId: 7,
        mode: 'shadow',
        flagged: true,
        acted: false,
        nsfwLevel: 8,
        tags: 'nsfw',
      })
    );
    const verdicts = vi
      .mocked(loggingMock.logToAxiom)
      .mock.calls.filter(([e]) => (e as { name?: string }).name === 'scan-verdict');
    expect(verdicts).toHaveLength(1);
  });

  it('logs a clean verdict too, and an active flagged one as acted', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'none', reason: 'r' } }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'scan-verdict',
        mode: 'active',
        flagged: false,
        acted: false,
      })
    );
    vi.mocked(loggingMock.logToAxiom).mockClear();
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'r' } }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-2', status: 'succeeded' });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'scan-verdict', mode: 'active', flagged: true, acted: true })
    );
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

  it('derives the shadow row from the mode when emEntityType is missing', async () => {
    const { emEntityType: _omit, ...noKey } = shadowMetadata;
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'r' } }, undefined, noKey) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(vi.mocked(updateMany).mock.calls[0][0].where).toMatchObject({
      entityType: 'Post:shadow',
    });
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
  });

  it('writes nothing when emEntityType disagrees with the mode', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'r' } }, undefined, {
        ...shadowMetadata,
        emEntityType: 'Post',
      }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).not.toHaveBeenCalled();
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
  });

  it('does not treat an inherited property name as a failure status', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(failed() as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'toString' } as any);
    const writes = vi.mocked(updateMany).mock.calls.map(([args]) => args.data.status);
    expect(writes.some((status) => typeof status === 'function')).toBe(false);
    expect(adapter.applyFailure).not.toHaveBeenCalled();
  });

  it('ignores a stale callback', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ nsfw: { level: 'x', reason: 'r' } }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-old', status: 'succeeded' });
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(loggingMock.logToAxiom)
        .mock.calls.filter(([e]) => (e as { name?: string }).name === 'scan-verdict')
    ).toHaveLength(0);
  });

  it('expects one step from a workflow without segments, so a second step is malformed', async () => {
    const wf = segmented([
      { nsfw: { level: 'none', reason: 'a' } },
      { nsfw: { level: 'none', reason: 'b' } },
    ]);
    delete (wf.data.metadata as Record<string, unknown>).segments;
    vi.mocked(getWorkflow).mockResolvedValue(wf as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(vi.mocked(updateMany).mock.calls[0][0].data).toMatchObject({ status: 'Failed' });
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'malformed', segments: 1 })
    );
  });

  it('records the validated segment count when the metadata one is unusable', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented([{ nsfw: { level: 'none', reason: 'a' } }], { segments: 0 }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(vi.mocked(updateMany).mock.calls[0][0].data.result.meta).toMatchObject({
      segments: 1,
    });
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
      { metadata: { ...metadata, entityType: 'Tag' }, tags: TAGS, steps: [] },
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

const segmented = (outputs: unknown[], meta: Record<string, unknown> = {}) => ({
  data: {
    metadata: {
      ...metadata,
      inputChars: 2500,
      inputCut: false,
      segments: outputs.length,
      scannedChars: 2500,
      ...meta,
    },
    tags: TAGS,
    steps: outputs.map((parsed, segment) => ({
      $type: 'chatCompletion',
      name: segment ? `textScan${segment}` : 'textScan',
      metadata: { segment },
      output:
        parsed === 'TRUNCATED'
          ? { choices: [{ message: { content: '{"nsfw":' }, finishReason: 'length' }] }
          : {
              choices: [{ message: { content: JSON.stringify(parsed) }, finishReason: 'stop' }],
              parsed,
            },
    })),
  },
});

describe('handleTextScanCallback with segments', () => {
  it('merges every segment into one verdict and records the segment meta', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented([
        { nsfw: { level: 'none', reason: 'clean' } },
        { nsfw: { level: 'x', reason: 'Explicit.' } },
      ]) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    const { data } = vi.mocked(updateMany).mock.calls[0][0];
    expect(data).toMatchObject({ status: 'Succeeded', triggeredLabels: ['nsfw'], nsfwLevel: 8 });
    expect(data.result).toMatchObject({
      version: 1,
      labels: { nsfw: { level: 'x', reason: 'Explicit.' } },
      meta: {
        inputChars: 2500,
        inputCut: false,
        segments: 2,
        scannedChars: 2500,
        flaggedSegments: { nsfw: [1] },
      },
    });
    expect(adapter.applyTextScan).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ nsfwLevel: 8 }) })
    );
  });

  it('fails the entity closed when one segment is unusable, naming the segment', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented([{ nsfw: { level: 'x', reason: 'Explicit.' } }, 'TRUNCATED']) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMany).mock.calls[0][0].data).toMatchObject({ status: 'Failed' });
    expect(adapter.applyFailure).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 7, status: 'failed' })
    );
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'truncated', segment: 1, segments: 2 })
    );
  });

  it('fails the entity closed, recording no verdict, when one segment lacks a label', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented([
        { nsfw: { level: 'x', reason: 'Explicit.' } },
        { scam: { detected: false, reason: 'No scam.' } },
      ]) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    const { data } = vi.mocked(updateMany).mock.calls[0][0];
    expect(data).toMatchObject({ status: 'Failed' });
    expect(data).not.toHaveProperty('result');
    expect(data).not.toHaveProperty('nsfwLevel');
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'missing_label', detail: 'nsfw', segment: 1 })
    );
  });

  it('fails the entity closed when the workflow is missing a submitted step', async () => {
    const wf = segmented([
      { nsfw: { level: 'none', reason: 'a' } },
      { nsfw: { level: 'none', reason: 'b' } },
    ]);
    wf.data.metadata.segments = 3;
    vi.mocked(getWorkflow).mockResolvedValue(wf as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(vi.mocked(updateMany).mock.calls[0][0].data).toMatchObject({ status: 'Failed' });
    expect(adapter.applyFailure).toHaveBeenCalled();
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'missing_segment', segment: 2 })
    );
  });

  it('fails an extra step with no segment in the log', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented(
        [{ nsfw: { level: 'none', reason: 'a' } }, { nsfw: { level: 'none', reason: 'b' } }],
        { segments: 1 }
      ) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(vi.mocked(updateMany).mock.calls[0][0].data).toMatchObject({ status: 'Failed' });
    const logged = vi
      .mocked(loggingMock.logToAxiom)
      .mock.calls.map(([event]) => event as Record<string, unknown>)
      .find((event) => event.message === 'unusable output');
    expect(logged).toMatchObject({ reason: 'malformed', segments: 1 });
    expect(logged).not.toHaveProperty('segment');
  });

  it('ignores a stale callback from a superseded multi-step workflow', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented([
        { nsfw: { level: 'x', reason: 'a' } },
        { nsfw: { level: 'x', reason: 'b' } },
      ]) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-old', status: 'succeeded' });
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
  });

  it('tags the verdict log when part of the text was not scanned', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented([{ nsfw: { level: 'none', reason: 'a' } }], {
        inputCut: true,
        scannedChars: 1000,
      }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'scan-verdict', tags: 'inputCut' })
    );
    expect(vi.mocked(updateMany).mock.calls[0][0].data.result.meta).toMatchObject({
      inputCut: true,
      segments: 1,
      scannedChars: 1000,
    });
    expect(vi.mocked(updateMany).mock.calls[0][0].data.result.meta).not.toHaveProperty(
      'flaggedSegments'
    );
  });
});

describe('handleTextScanCallback with some segments unusable', () => {
  const findUnique = dbMock.dbWrite.entityModeration.findUnique;
  beforeEach(() => findUnique.mockReset());
  const LABELS = { labels: ['nsfw', 'minor'] };
  const CLEAN = {
    nsfw: { level: 'none', reason: 'clean' },
    minor: { detected: false, reason: 'n' },
  };
  const MINOR = {
    nsfw: { level: 'none', reason: 'clean' },
    minor: { detected: true, reason: 'm' },
  };
  const stored = (over: Record<string, unknown> = {}) => ({
    workflowId: 'wf-1',
    nsfwLevel: 1,
    triggeredLabels: [],
    result: {
      version: 1,
      labels: CLEAN,
      promptIds: { base: 1 },
      model: 'air:old',
      textHash: 'old',
    },
    ...over,
  });
  const raiseWrite = () => vi.mocked(updateMany).mock.calls[1]?.[0] as any;
  const logged = (message: string) =>
    vi
      .mocked(loggingMock.logToAxiom)
      .mock.calls.map(([event]) => event as Record<string, unknown>)
      .find((event) => event.message === message);

  it('active: leaves the row Failed for retry and applies what the parsed segments raised', async () => {
    findUnique.mockResolvedValue(stored() as any);
    vi.mocked(getWorkflow).mockResolvedValue(segmented([MINOR, 'TRUNCATED'], LABELS) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });

    expect(vi.mocked(updateMany).mock.calls[0][0].data).toMatchObject({
      status: 'Failed',
      retryCount: { increment: 1 },
    });
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(raiseWrite().where).toEqual({
      entityType: 'Post',
      entityId: 7,
      workflowId: 'wf-1',
      status: 'Failed',
    });
    expect(raiseWrite().data).not.toHaveProperty('status');
    expect(raiseWrite().data).toMatchObject({ triggeredLabels: ['minor'], nsfwLevel: 1 });
    expect(raiseWrite().data.result).toMatchObject({
      version: 1,
      textHash: 'old',
      labels: { nsfw: CLEAN.nsfw, minor: MINOR.minor },
    });

    const [{ outcome }] = adapter.applyTextScan.mock.calls[0];
    expect(outcome.triggeredLabels).toEqual(['minor']);
    expect(outcome).not.toHaveProperty('nsfw');
    expect(adapter.applyFailure).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' })
    );
    expect(adapter.applyTextScan.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.applyFailure.mock.invocationCallOrder[0]
    );
    expect(logged('partial verdict raised')).toMatchObject({
      raised: ['minor'],
      parsedSegments: 1,
      segments: 2,
      acted: true,
    });
  });

  it('raises nsfw only above the stored level', async () => {
    findUnique.mockResolvedValue(stored({ nsfwLevel: 4 }) as any);
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented([{ ...CLEAN, nsfw: { level: 'x', reason: 'X.' } }, 'TRUNCATED'], LABELS) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(raiseWrite().data).toMatchObject({ nsfwLevel: 8, triggeredLabels: ['nsfw'] });
    expect(adapter.applyTextScan.mock.calls[0][0].outcome).toMatchObject({
      nsfwLevel: 8,
      triggeredLabels: ['nsfw'],
    });
  });

  it('shadow: raises the shadow row and acts on nothing', async () => {
    findUnique.mockResolvedValue(stored() as any);
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented([MINOR, 'TRUNCATED'], { ...shadowMetadata, ...LABELS }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(raiseWrite().where).toMatchObject({ entityType: 'Post:shadow', status: 'Failed' });
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(logged('partial verdict raised')).toMatchObject({ acted: false });
    expect(adapter.applyFailure).not.toHaveBeenCalled();
  });

  it('never lowers or clears a stricter stored verdict', async () => {
    findUnique.mockResolvedValue(
      stored({
        nsfwLevel: 16,
        triggeredLabels: ['nsfw', 'minor'],
        result: { version: 1, labels: { nsfw: { level: 'xxx', reason: 'a' }, minor: MINOR.minor } },
      }) as any
    );
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented([{ ...MINOR, nsfw: { level: 'x', reason: 'X.' } }, 'TRUNCATED'], LABELS) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(adapter.applyFailure).toHaveBeenCalled();
    expect(logged('partial verdict raised')).toBeUndefined();
  });

  it('raises nothing on a row a newer workflow already owns', async () => {
    findUnique.mockResolvedValue(stored({ workflowId: 'wf-2' }) as any);
    vi.mocked(getWorkflow).mockResolvedValue(segmented([MINOR, 'TRUNCATED'], LABELS) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
  });

  it('with no segment parsed, fails as before without reading the stored verdict', async () => {
    vi.mocked(getWorkflow).mockResolvedValue(segmented(['TRUNCATED', 'TRUNCATED'], LABELS) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMany).mock.calls[0][0].data).toMatchObject({ status: 'Failed' });
    expect(findUnique).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(adapter.applyFailure).toHaveBeenCalled();
  });

  it('still runs the failure hook when applying the partial verdict throws', async () => {
    findUnique.mockResolvedValue(stored() as any);
    adapter.applyTextScan.mockRejectedValueOnce(new Error('db down'));
    vi.mocked(getWorkflow).mockResolvedValue(segmented([MINOR, 'TRUNCATED'], LABELS) as any);
    await expect(
      handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' })
    ).rejects.toThrow('db down');
    expect(adapter.applyFailure).toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(3);
  });

  /** One EntityModeration row the mocked updateMany writes to, guarded by its `where`. */
  function fakeRow(initial: Record<string, unknown>) {
    const row: Record<string, any> = { status: 'Pending', ...initial };
    findUnique.mockImplementation((async () => ({ ...row })) as any);
    vi.mocked(updateMany).mockImplementation((async ({ where, data }: any) => {
      const { workflowId, status } = where;
      const ownsRow =
        typeof workflowId === 'object'
          ? workflowId.in.includes(row.workflowId)
          : workflowId === row.workflowId;
      if (!ownsRow || (status && status !== row.status)) return { count: 0 };
      for (const [key, value] of Object.entries(data)) {
        if (key === 'retryCount') row.retryCount = (row.retryCount ?? 0) + 1;
        else row[key] = value;
      }
      return { count: 1 };
    }) as any);
    return row;
  }

  it('reverts the raise when applying it throws, so the next callback raises and acts again', async () => {
    const row = fakeRow(stored());
    vi.mocked(getWorkflow).mockResolvedValue(segmented([MINOR, 'TRUNCATED'], LABELS) as any);
    adapter.applyTextScan.mockRejectedValueOnce(new Error('db down'));
    await expect(
      handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' })
    ).rejects.toThrow('db down');
    expect(row).toMatchObject({
      status: 'Failed',
      nsfwLevel: 1,
      triggeredLabels: [],
      result: stored().result,
    });
    expect(logged('applying the partial verdict failed')).toMatchObject({ reverted: true });

    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(adapter.applyTextScan).toHaveBeenCalledTimes(2);
    expect(row.triggeredLabels).toEqual(['minor']);
  });

  it('adds the raised flag to the flags already stored', async () => {
    findUnique.mockResolvedValue(
      stored({
        triggeredLabels: ['poi'],
        result: {
          version: 1,
          labels: { ...CLEAN, poi: { detected: true, names: [], reason: 'p' } },
        },
      }) as any
    );
    vi.mocked(getWorkflow).mockResolvedValue(segmented([MINOR, 'TRUNCATED'], LABELS) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(raiseWrite().data.triggeredLabels).toEqual(['poi', 'minor']);
  });

  it('acts on nothing when the raise write matches no row', async () => {
    findUnique.mockResolvedValue(stored() as any);
    vi.mocked(updateMany).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    vi.mocked(getWorkflow).mockResolvedValue(segmented([MINOR, 'TRUNCATED'], LABELS) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(logged('partial verdict raised')).toBeUndefined();
  });

  it('raises nothing for an entity that no longer loads', async () => {
    findUnique.mockResolvedValue(stored() as any);
    load.mockResolvedValue(new Map());
    vi.mocked(getWorkflow).mockResolvedValue(segmented([MINOR, 'TRUNCATED'], LABELS) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(adapter.applyFailure).toHaveBeenCalled();
  });

  it('raises nothing for a subject no longer public, keeping the stored verdict', async () => {
    const row = fakeRow(stored());
    load.mockResolvedValue(
      new Map([[7, { fields: [], declared: { nsfwLevel: 1 }, notPublic: true }]])
    );
    vi.mocked(getWorkflow).mockResolvedValue(segmented([MINOR, 'TRUNCATED'], LABELS) as any);
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({
      status: 'Failed',
      nsfwLevel: stored().nsfwLevel,
      triggeredLabels: stored().triggeredLabels,
      result: stored().result,
    });
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
  });

  it('starts a text-scan result, stamped with the submitted textHash, on a row that had none', async () => {
    findUnique.mockResolvedValue(stored({ nsfwLevel: null, result: null }) as any);
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented([MINOR, 'TRUNCATED'], { ...LABELS, textHash: 'th-new' }) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(raiseWrite().data.result).toEqual({
      version: 1,
      labels: { minor: MINOR.minor },
      promptIds: { base: 1, nsfw: 2 },
      model: 'air:test',
      textHash: 'th-new',
    });
  });

  it.each([
    ['a pre-text-scan result', { result: { labels: ['nsfw'] }, triggeredLabels: [] }],
    ['a pre-text-scan flag with no result', { result: null, triggeredLabels: ['nsfw'] }],
    ['a blocked pre-text-scan row', { result: null, blocked: true }],
  ])('leaves %s to a full verdict', async (_name, over) => {
    findUnique.mockResolvedValue(stored(over) as any);
    vi.mocked(getWorkflow).mockResolvedValue(
      segmented([{ ...MINOR, nsfw: { level: 'x', reason: 'X.' } }, 'TRUNCATED'], LABELS) as any
    );
    await handleTextScanCallback({ workflowId: 'wf-1', status: 'succeeded' });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
  });
});

describe('a chat window verdict in csam review', () => {
  it('reloads an older account’s window instead of dropping it as gone', async () => {
    vi.mocked(getTextScanCsamMode).mockResolvedValue('review');
    dbMock.dbWrite.chatMessage.findUnique.mockResolvedValue({
      id: 30,
      chatId: 4,
      userId: 5,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      editedAt: null,
      contentType: 'Markdown',
      deletedAt: null,
    });
    dbMock.dbWrite.chatMessage.findFirst.mockResolvedValue(null);
    dbMock.dbWrite.chatMessage.findMany.mockResolvedValue([{ id: 30, content: 'neutral chat' }]);
    dbMock.dbWrite.user.findMany.mockResolvedValue([]);
    dbMock.dbWrite.challengeJudge.findMany.mockResolvedValue([]);
    const chatMeta = {
      ...metadata,
      entityType: 'ChatMessage',
      entityId: 30,
      emEntityType: 'ChatMessage',
      externalId: 'ts-ChatMessage-30-abc-0-0',
      labels: ['csam'],
      promptIds: { base: 1, csam: 7 },
    };
    vi.mocked(getWorkflow).mockResolvedValue(
      workflow({ csam: { detected: true, reason: 'test' } }, undefined, chatMeta) as any
    );

    await handleTextScanCallback({ workflowId: 'wf-9', status: 'succeeded' });

    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'entity gone before callback' })
    );
    expect(adapter.applyTextScan).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 30, promptIds: { base: 1, csam: 7 } })
    );
  });
});

describe('a callback for the retired ModelRules LLM scan', () => {
  const retired = (mode: 'active' | 'shadow') => ({
    ...metadata,
    entityType: 'ModelRules',
    entityId: 9,
    emEntityType: mode === 'shadow' ? 'ModelRules:shadow' : 'ModelRules',
    mode,
    labels: ['modelRules'],
  });

  it.each([
    ['active', 'succeeded'],
    ['shadow', 'succeeded'],
    ['active', 'failed'],
    ['shadow', 'expired'],
  ] as const)('drops a %s %s workflow without recording or acting', async (mode, status) => {
    const body = { modelRules: { matches: [], reason: 'No match.' } };
    vi.mocked(getWorkflow).mockResolvedValue(
      (status === 'succeeded'
        ? workflow(body, undefined, retired(mode))
        : failed(retired(mode))) as any
    );

    await expect(handleTextScanCallback({ workflowId: 'wf-old', status })).resolves.toBeUndefined();

    expect(updateMany).not.toHaveBeenCalled();
    expect(adapter.applyTextScan).not.toHaveBeenCalled();
    expect(adapter.applyFailure).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        message: 'callback for the retired ModelRules scan dropped',
        workflowId: 'wf-old',
      })
    );
  });
});
