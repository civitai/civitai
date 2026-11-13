import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

vi.mock('@civitai/orchestration-client', async () => ({
  ...(await import('./civitai-client.stub')).civitaiClientStub(),
  submitWorkflow: mockSubmitWorkflow,
  WorkflowStatus: {},
  TimeSpan: { fromDays: vi.fn(), fromHours: vi.fn() },
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));

const { createXGuardModerationRequest } = await import(
  '~/server/services/orchestrator/orchestrator.service'
);

const { dbRead, dbWrite } = dbMock;

const submit = (rearmRetries?: boolean) =>
  createXGuardModerationRequest({
    mode: 'text',
    entityType: 'Article',
    entityId: 7,
    content: 'An article body',
    rearmRetries,
  });

const upsertUpdate = () => dbWrite.entityModeration.upsert.mock.calls.at(-1)?.[0].update;

describe('createXGuardModerationRequest retry budget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbRead.entityModeration.findUnique.mockResolvedValue(null);
    dbWrite.entityModeration.upsert.mockResolvedValue({});
  });

  describe('when the submit succeeds', () => {
    beforeEach(() => {
      mockSubmitWorkflow.mockResolvedValue({ data: { id: 'wf-new' }, response: { status: 200 } });
    });

    // A row parked at the cap is skipped by the retry cron, so a lost callback would strand it.
    it('re-arms the retries of a fresh submit', async () => {
      await submit(true);
      expect(upsertUpdate()).toMatchObject({ status: 'Pending', retryCount: 0 });
    });

    it('leaves the count alone on a retry, so the cap still holds', async () => {
      await submit();
      expect(upsertUpdate()).toMatchObject({ status: 'Pending' });
      expect(upsertUpdate()).not.toHaveProperty('retryCount');
    });
  });

  describe('when the submit fails', () => {
    beforeEach(() => {
      mockSubmitWorkflow.mockResolvedValue({ data: undefined, error: 'down', response: {} });
    });

    it('counts a fresh submit as the first attempt', async () => {
      await submit(true);
      expect(upsertUpdate()).toMatchObject({ status: 'Failed', retryCount: 1 });
    });

    it('counts a retry against the cap', async () => {
      await submit();
      expect(upsertUpdate()).toMatchObject({ status: 'Failed', retryCount: { increment: 1 } });
    });
  });
});
