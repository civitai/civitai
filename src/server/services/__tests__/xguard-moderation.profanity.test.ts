import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

vi.mock('@civitai/orchestration-client', async () => ({
  ...(await import('../orchestrator/__tests__/civitai-client.stub')).civitaiClientStub(),
  submitWorkflow: mockSubmitWorkflow,
  WorkflowStatus: {},
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));

const { createXGuardModerationRequest } = await import(
  '~/server/services/orchestrator/orchestrator.service'
);

const { dbRead, dbWrite } = dbMock;
const step = () => mockSubmitWorkflow.mock.calls.at(-1)?.[0].body.steps[0];

beforeEach(() => {
  vi.clearAllMocks();
  dbRead.entityModeration.findUnique.mockResolvedValue(null);
  dbWrite.entityModeration.upsert.mockResolvedValue({});
  mockSubmitWorkflow.mockResolvedValue({ data: { id: 'wf-new' }, response: { status: 200 } });
});

describe('an XGuard profanity request', () => {
  it('sends the text to be rated for language, with no label selection, and records it Pending', async () => {
    await createXGuardModerationRequest({
      mode: 'profanity',
      entityType: 'TrackLyricsLanguage',
      entityId: 7,
      content: 'some lyrics',
    });

    expect(step().input).toEqual({
      mode: 'profanity',
      text: 'some lyrics',
      storeFullResponse: false,
      includeReasoning: false,
    });
    expect(step().metadata).toMatchObject({ mode: 'profanity', entityId: 7 });
    expect(dbWrite.entityModeration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType_entityId: { entityType: 'TrackLyricsLanguage', entityId: 7 } },
        update: expect.objectContaining({ status: 'Pending', workflowId: 'wf-new' }),
      })
    );
  });

  it('is not sent again for text that already has its verdict', async () => {
    const first = createXGuardModerationRequest({
      mode: 'profanity',
      entityType: 'TrackLyricsLanguage',
      entityId: 7,
      content: 'same lyrics',
    });
    await first;
    const { contentHash } = dbWrite.entityModeration.upsert.mock.calls[0][0].update as {
      contentHash: string;
    };
    dbRead.entityModeration.findUnique.mockResolvedValue({
      status: 'Succeeded',
      contentHash,
      workflowId: 'wf-old',
    } as never);
    mockSubmitWorkflow.mockClear();

    const again = await createXGuardModerationRequest({
      mode: 'profanity',
      entityType: 'TrackLyricsLanguage',
      entityId: 7,
      content: 'same lyrics',
    });

    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
    expect(again?.id).toBe('wf-old');
  });
});

describe('an XGuard text request', () => {
  it('still asks for its labels in text mode', async () => {
    await createXGuardModerationRequest({
      mode: 'text',
      entityType: 'Article',
      entityId: 7,
      content: 'An article body',
      labels: ['nsfw'],
    });

    expect(step().input).toMatchObject({ mode: 'text', text: 'An article body', labels: ['nsfw'] });
  });
});
