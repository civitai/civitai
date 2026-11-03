import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { calledHybridNodes } from '~/__tests__/mocks/hybrid';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as EntityModeration from '~/server/services/entity-moderation.service';
import type * as ModerationAdapters from '~/server/services/moderation-adapters';

// The shadow verdict must never change an image: every database call the callback makes is
// recorded by the canonical db mock, and only the label-store prediction may appear.

const { getWorkflow, insert, recordEntityModerationSuccess, getModerationAdapter } = vi.hoisted(
  () => ({
    getWorkflow: vi.fn(),
    insert: vi.fn(),
    recordEntityModerationSuccess: vi.fn(),
    getModerationAdapter: vi.fn(),
  })
);

vi.mock('~/server/clickhouse/client', () => ({ clickhouse: { insert } }));
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
vi.mock('~/server/services/entity-moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof EntityModeration>()),
  recordEntityModerationSuccess,
}));
vi.mock('~/server/services/moderation-adapters', async (importOriginal) => ({
  ...(await importOriginal<typeof ModerationAdapters>()),
  getModerationAdapter,
}));

import handler from '~/pages/api/webhooks/text-moderation-result';

const PROMPT_HASH = 'b'.repeat(64);
const shadowMarker = {
  kind: 'sexual-prompt',
  imageId: 9001,
  currentNsfwLevel: 1,
  onSite: false,
  promptHash: PROMPT_HASH,
};

function workflow(metadata: Record<string, unknown>, field = 'Positive Prompt') {
  return {
    id: 'wf-shadow',
    status: 'succeeded',
    completedAt: '2026-11-03T02:00:00Z',
    metadata: { mode: 'prompt', recordForReview: false, version: '1', ...metadata },
    steps: [
      {
        $type: 'xGuardModeration',
        input: { mode: 'prompt', positivePrompt: 'secret prompt words', negativePrompt: null },
        output: {
          blocked: false,
          triggeredLabels: ['Sexual'],
          results: [
            {
              label: 'Sexual',
              score: 0.91,
              threshold: 0.5,
              triggered: true,
              field,
              policyHash: 'p1',
              modelReason: '',
            },
          ],
        },
      },
    ],
  };
}

async function deliver(metadata: Record<string, unknown>, field?: string) {
  getWorkflow.mockResolvedValue({ data: workflow(metadata, field) });
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await (handler as unknown as (req: object, res: object) => Promise<unknown>)(
    { method: 'POST', body: { workflowId: 'wf-shadow', status: 'succeeded' } },
    res
  );
  return res.status.mock.calls[0]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockResolvedValue(undefined);
  recordEntityModerationSuccess.mockResolvedValue(true);
  getModerationAdapter.mockReturnValue(undefined);
});

describe('text-moderation-result: shadow sexual-prompt verdicts', () => {
  it('records a firing verdict on a PG image without touching the image', async () => {
    expect(await deliver({ shadow: shadowMarker })).toBe(200);

    expect(calledHybridNodes(['dbRead', 'dbWrite'])).toEqual(['dbWrite.$queryRaw']);
    const [sql] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [string[]];
    expect(sql.join('?')).toContain('label_store.record_prediction');
    expect(recordEntityModerationSuccess).not.toHaveBeenCalled();
    expect(getModerationAdapter).not.toHaveBeenCalled();

    expect(insert).toHaveBeenCalledTimes(1);
    const [row] = insert.mock.calls[0][0].values;
    expect(row).toMatchObject({
      imageId: 9001,
      promptHash: PROMPT_HASH,
      triggered: 1,
      field: 'Positive Prompt',
      currentNsfwLevel: 1,
      wouldNsfwLevel: 4,
      wouldRaise: 1,
      onSite: 0,
    });
    expect(JSON.stringify([insert.mock.calls, dbMock.dbWrite.$queryRaw.mock.calls])).not.toContain(
      'secret prompt words'
    );
  });

  it('does not count a fire on the negative prompt, and still records the field', async () => {
    await deliver({ shadow: shadowMarker }, 'Negative Prompt');

    const [row] = insert.mock.calls[0][0].values;
    expect(row).toMatchObject({
      triggered: 1,
      field: 'Negative Prompt',
      wouldNsfwLevel: 1,
      wouldRaise: 0,
    });
  });

  it('keys on the marker, not on a missing entity: a marked workflow with an entity stays shadow', async () => {
    await deliver({ shadow: shadowMarker, entityType: 'Article', entityId: 5 });

    expect(recordEntityModerationSuccess).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('a malformed marker falls through to the normal entity path', async () => {
    await deliver({ shadow: { kind: 'sexual-prompt' }, entityType: 'Article', entityId: 5 });

    expect(insert).not.toHaveBeenCalled();
    expect(recordEntityModerationSuccess).toHaveBeenCalledTimes(1);
  });
});
