import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { XGuardLabelOverride } from '~/server/services/orchestrator/orchestrator.service';

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

vi.mock('@civitai/client', () => ({
  submitWorkflow: mockSubmitWorkflow,
  WorkflowStatus: {},
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));

const { createXGuardModerationRequest } = await import(
  '~/server/services/orchestrator/orchestrator.service'
);

const { dbRead, dbWrite } = dbMock;

const CONTENT = 'A model name and its description';
const ENTITY = { entityType: 'Model', entityId: 7 } as const;

const OVERRIDES: XGuardLabelOverride[] = [
  { label: 'explicit', action: 'Scan', threshold: 0.9, policy: 'candidate prose' },
  { label: 'suggestive', action: 'Scan', threshold: 0.8, policy: 'other prose' },
];

/** Submit past the dedup and report the `contentHash` the request stored on the row. */
async function storedHashFor(labelOverrides?: XGuardLabelOverride[]) {
  dbRead.entityModeration.findUnique.mockResolvedValue(null);
  await createXGuardModerationRequest({
    mode: 'text',
    ...ENTITY,
    content: CONTENT,
    labelOverrides,
  });
  const upsert = dbWrite.entityModeration.upsert.mock.calls.at(-1)?.[0];
  return upsert.create.contentHash as string;
}

/** Present a Succeeded row the dedup is allowed to answer from, and forget the setup submit. */
function cached(contentHash: string) {
  dbRead.entityModeration.findUnique.mockResolvedValue({
    status: 'Succeeded',
    contentHash,
    workflowId: 'wf-cached',
  });
  mockSubmitWorkflow.mockClear();
}

describe('createXGuardModerationRequest dedup with label overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubmitWorkflow.mockResolvedValue({ data: { id: 'wf-new' }, response: { status: 200 } });
    dbWrite.entityModeration.upsert.mockResolvedValue({});
  });

  it('still dedups unchanged content scanned under the registry default', async () => {
    cached(await storedHashFor());

    const result = await createXGuardModerationRequest({
      mode: 'text',
      ...ENTITY,
      content: CONTENT,
    });

    expect(result).toEqual({ id: 'wf-cached' });
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  // The bug this guards: the cached row was scored under the registry default, so answering an
  // override request from it reports a candidate policy's verdict without ever running it.
  it('does not answer an override request from a row scanned without them', async () => {
    cached(await storedHashFor());

    const result = await createXGuardModerationRequest({
      mode: 'text',
      ...ENTITY,
      content: CONTENT,
      labelOverrides: OVERRIDES,
    });

    expect(mockSubmitWorkflow).toHaveBeenCalled();
    expect(result).toEqual({ id: 'wf-new' });
  });

  it('does not answer a changed policy from the previous policy', async () => {
    cached(await storedHashFor(OVERRIDES));

    await createXGuardModerationRequest({
      mode: 'text',
      ...ENTITY,
      content: CONTENT,
      labelOverrides: [{ ...OVERRIDES[0], threshold: 0.5 }, OVERRIDES[1]],
    });

    expect(mockSubmitWorkflow).toHaveBeenCalled();
  });

  // Without this the dedup never hits for a steady-state per-surface policy, and every save of
  // an unchanged entity burns a scan — the cost the dedup exists to avoid.
  it('dedups the same policy given in a different order', async () => {
    cached(await storedHashFor(OVERRIDES));

    const result = await createXGuardModerationRequest({
      mode: 'text',
      ...ENTITY,
      content: CONTENT,
      labelOverrides: [OVERRIDES[1], OVERRIDES[0]],
    });

    expect(result).toEqual({ id: 'wf-cached' });
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });
});
