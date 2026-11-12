import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as ModerationAdapters from '~/server/services/moderation-adapters';

// A verdict for text an article no longer has must not land on the row its newer text owns.

const { getWorkflow, getModerationAdapter, applyResult, applyFailure } = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  getModerationAdapter: vi.fn(),
  applyResult: vi.fn(),
  applyFailure: vi.fn(),
}));

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { insert: vi.fn() } }));
// The package's ESM entry cannot load under vitest; the shared stub stands in for it.
vi.mock('@civitai/orchestration-client', async () => ({
  ...(
    await import('~/server/services/orchestrator/__tests__/civitai-client.stub')
  ).civitaiClientStub(),
  getWorkflow,
  WorkflowStatus: {},
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof ModerationAdapters>()),
  getModerationAdapter,
}));

import handler from '~/pages/api/webhooks/text-moderation-result';
import { recordTextScanSuccess } from '~/server/services/text-scan/record';

const ARTICLE = 41;

type Row = {
  entityType: string;
  entityId: number;
  workflowId: string | null;
  status: string;
  blocked: boolean | null;
};
let row: Row;

/** updateMany as Postgres runs it: the write lands only where every `where` key matches. */
function matches(where: Record<string, unknown>) {
  return Object.entries(where).every(([key, want]) => {
    const have = row[key as keyof Row];
    if (want && typeof want === 'object' && 'in' in want)
      return (want as { in: unknown[] }).in.includes(have);
    return have === want;
  });
}

async function callback(workflowId: string, { blocked = false, status = 'succeeded' } = {}) {
  getWorkflow.mockResolvedValue({
    data: {
      id: workflowId,
      status,
      metadata: { mode: 'text', entityType: 'Article', entityId: ARTICLE, version: '1' },
      steps: [
        {
          $type: 'xGuardModeration',
          output: { blocked, triggeredLabels: blocked ? ['nsfw'] : [], results: [] },
        },
      ],
    },
  });
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await (handler as unknown as (req: object, res: object) => Promise<unknown>)(
    { method: 'POST', body: { workflowId, status } },
    res
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The edited text's scan is in flight.
  row = {
    entityType: 'Article',
    entityId: ARTICLE,
    workflowId: 'wf-new',
    status: 'Pending',
    blocked: null,
  };
  dbMock.dbWrite.entityModeration.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: Record<string, unknown>;
    data: Partial<Row>;
  }) => {
    if (!matches(where)) return { count: 0 };
    row = { ...row, ...data };
    return { count: 1 };
  }) as never);
  getModerationAdapter.mockReturnValue({ applyResult, applyFailure });
});

describe('a text-moderation callback for the current submit', () => {
  it('positive control: records the verdict and applies it to the article', async () => {
    await callback('wf-new', { blocked: true });
    expect(row).toMatchObject({ status: 'Succeeded', blocked: true });
    expect(applyResult).toHaveBeenCalledWith(expect.objectContaining({ entityId: ARTICLE }));
  });
});

describe('a text-moderation callback for older text', () => {
  it('leaves the newer pending row alone and does not apply its verdict', async () => {
    await callback('wf-old');
    expect(row).toMatchObject({ workflowId: 'wf-new', status: 'Pending', blocked: null });
    expect(applyResult).not.toHaveBeenCalled();
  });

  it('cannot land on a row held after a failed submit either', async () => {
    row = { ...row, workflowId: null };
    await callback('wf-old');
    expect(row).toMatchObject({ workflowId: null, status: 'Pending' });
    expect(applyResult).not.toHaveBeenCalled();
  });

  it('a late failure for older text does not mark the newer row failed', async () => {
    await callback('wf-old', { status: 'failed' });
    expect(row).toMatchObject({ workflowId: 'wf-new', status: 'Pending' });
    expect(applyFailure).not.toHaveBeenCalled();
  });
});

describe('a text-scan verdict for older text', () => {
  const record = (workflowId: string) =>
    recordTextScanSuccess({
      entityType: 'Article',
      entityId: ARTICLE,
      workflowId,
      outcome: { triggeredLabels: [], nsfwLevel: 1 } as never,
      output: {},
      promptIds: {},
      model: 'm',
    });

  it('positive control: the current workflow records', async () => {
    expect(await record('wf-new')).toBe(true);
    expect(row.status).toBe('Succeeded');
  });

  it('does not record over the newer pending row', async () => {
    expect(await record('wf-old')).toBe(false);
    expect(row).toMatchObject({ workflowId: 'wf-new', status: 'Pending' });
  });
});
