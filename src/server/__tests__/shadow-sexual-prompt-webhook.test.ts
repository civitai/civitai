import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { calledHybridNodes } from '~/__tests__/mocks/hybrid';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
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

type ResultOverride = Record<string, unknown> | null;

function workflow(
  metadata: Record<string, unknown>,
  { field = 'Positive Prompt', result = {} as ResultOverride } = {}
) {
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
          results:
            result === null
              ? []
              : [
                  {
                    label: 'Sexual',
                    score: 0.91,
                    threshold: 0.123,
                    triggered: true,
                    field,
                    policyHash: 'p1',
                    modelReason: '',
                    ...result,
                  },
                ],
        },
      },
    ],
  };
}

async function deliver(
  metadata: Record<string, unknown>,
  opts: { field?: string; result?: ResultOverride; status?: string } = {}
) {
  getWorkflow.mockResolvedValue({ data: workflow(metadata, opts) });
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  await (handler as unknown as (req: object, res: object) => Promise<unknown>)(
    { method: 'POST', body: { workflowId: 'wf-shadow', status: opts.status ?? 'succeeded' } },
    res
  );
  return res.status.mock.calls[0]?.[0];
}

const predictionValues = () => dbMock.dbWrite.$queryRaw.mock.calls[0].slice(1) as unknown[];
const predictionItem = () => {
  const [strings, ...values] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
  const item: Record<string, unknown> = {};
  values.forEach((value, i) => {
    const key = /'(\w+)',\s*$/.exec(strings[i])?.[1];
    if (key) item[key] = value;
  });
  return item;
};
const predictionKeys = () => {
  const [strings] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [string[]];
  return [...strings.join('').matchAll(/^\s*'(\w+)',/gm)].map((m) => m[1]);
};
const nothingWritten = () => {
  expect(insert).not.toHaveBeenCalled();
  expect(calledHybridNodes(['dbRead', 'dbWrite'])).toEqual([]);
  expect(recordEntityModerationSuccess).not.toHaveBeenCalled();
  expect(getModerationAdapter).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockResolvedValue(undefined);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ status: 'recorded', error: null }]);
  recordEntityModerationSuccess.mockResolvedValue(true);
  getModerationAdapter.mockReturnValue(undefined);
});

describe('text-moderation-result: shadow sexual-prompt verdicts', () => {
  it('records a firing verdict on a PG image without touching the image', async () => {
    expect(await deliver({ shadow: shadowMarker })).toBe(200);

    expect(calledHybridNodes(['dbRead', 'dbWrite'])).toEqual(['dbWrite.$queryRaw']);
    const [sql] = dbMock.dbWrite.$queryRaw.mock.calls[0] as [string[]];
    expect(sql.join('?')).toContain('label_store.submit_predictions(');
    // The keys submit_predictions reads. A misspelt required key refuses the item; a misspelt optional
    // one is silently NULL.
    expect(predictionKeys()).toEqual([
      'subjectType',
      'subjectId',
      'contentHash',
      'question',
      'value',
      'modelRef',
      'sourceRef',
      'predictedAt',
      'questionVersion',
      'confidence',
      'scores',
      'versions',
      'inputHash',
      'detail',
    ]);
    expect(predictionItem()).toMatchObject({
      subjectId: '9001',
      question: 'image.prompt_sexual',
      value: 'sexual',
      modelRef: 'xguard-prompt@p1',
      sourceRef: 'ShadowSexualPrompt:wf-shadow',
      confidence: 0.91,
      inputHash: PROMPT_HASH,
      scores: JSON.stringify({ sexual: 0.91 }),
      versions: JSON.stringify({ policy: 'p1', threshold: 0.123 }),
      detail: JSON.stringify({
        field: 'Positive Prompt',
        triggered: true,
        onSite: false,
        currentNsfwLevel: 1,
        wouldNsfwLevel: 4,
      }),
      predictedAt: new Date('2026-11-03T02:00:00Z'),
    });
    const text = (sql as string[]).join('?');
    expect(text).toMatch(/'subjectType', 'image',/);
    expect(text).toMatch(/'contentHash', label_store\.text_hash\(i\."url"\),/);
    expect(text).toMatch(/'questionVersion', 1,/);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
    expect(predictionValues()).toEqual(
      expect.arrayContaining([
        'image.prompt_sexual',
        'sexual',
        'ShadowSexualPrompt:wf-shadow',
        PROMPT_HASH,
      ])
    );
    expect(recordEntityModerationSuccess).not.toHaveBeenCalled();
    expect(getModerationAdapter).not.toHaveBeenCalled();

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0].values).toEqual([
      {
        imageId: 9001,
        promptHash: PROMPT_HASH,
        workflowId: 'wf-shadow',
        score: 0.91,
        threshold: 0.123,
        triggered: 1,
        field: 'Positive Prompt',
        onSite: 0,
        currentNsfwLevel: 1,
        wouldNsfwLevel: 4,
        wouldRaise: 1,
        policyHash: 'p1',
        modelVersion: 'xguard-prompt',
        scannedAt: '2026-11-03 02:00:00',
      },
    ]);
    expect(JSON.stringify([insert.mock.calls, dbMock.dbWrite.$queryRaw.mock.calls])).not.toContain(
      'secret prompt words'
    );
  });

  it('does not count a fire on the negative prompt, in either store, and still records the field', async () => {
    await deliver({ shadow: shadowMarker }, { field: 'Negative Prompt' });

    expect(insert.mock.calls[0][0].values[0]).toMatchObject({
      triggered: 1,
      field: 'Negative Prompt',
      wouldNsfwLevel: 1,
      wouldRaise: 0,
    });
    expect(predictionValues()).toContain('not_sexual');
    expect(predictionValues()).not.toContain('sexual');
  });

  it.each([
    ['no Sexual result', { result: null }],
    ['an errored Sexual result', { result: { triggered: false, error: 'model unavailable' } }],
  ])('records nothing for %s', async (_, opts) => {
    expect(await deliver({ shadow: shadowMarker }, opts)).toBe(200);
    nothingWritten();
  });

  it.each(['failed', 'expired', 'canceled'])(
    'records nothing for a %s shadow workflow',
    async (status) => {
      expect(await deliver({ shadow: shadowMarker }, { status })).toBe(200);
      nothingWritten();
    }
  );

  it('keeps the label-store prediction when the ClickHouse write fails', async () => {
    insert.mockRejectedValue(new Error('clickhouse down'));
    expect(await deliver({ shadow: shadowMarker })).toBe(200);
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('keeps the ClickHouse row when the label-store write fails', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValue(new Error('lock timeout'));
    expect(await deliver({ shadow: shadowMarker })).toBe(200);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('logs a prediction the label store refuses, and keeps the ClickHouse row', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ status: 'rejected', error: 'subject erased' }]);
    expect(await deliver({ shadow: shadowMarker })).toBe(200);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'shadow-sexual-prompt',
        message: 'prediction rejected: subject erased',
        imageId: 9001,
      })
    );
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
