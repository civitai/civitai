import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const status = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('~/server/services/orchestrator/workflows', () => ({ submitWorkflow: vi.fn() }));
vi.mock('~/server/services/training.service', () => ({
  getTrainingServiceStatus: vi.fn(async () => status.value),
}));

import { createTrainingWorkflow } from '~/server/services/orchestrator/training/training.orch';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { CLASSIC_TRAINER_RETIRES_AT } from '~/shared/constants/training.constants';

describe('createTrainingWorkflow on a blocked base model', () => {
  beforeEach(() => {
    setEnv({ WEBHOOK_URL: 'https://webhook.test', WEBHOOK_TOKEN: 't' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(CLASSIC_TRAINER_RETIRES_AT.getTime() - 86_400_000);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([
      {
        trainingDetails: { baseModel: 'krea2', params: { engine: 'ai-toolkit' } },
        userId: 7,
        modelVersionId: 55,
      },
    ]);
  });
  afterEach(() => vi.useRealTimers());

  const submit = () =>
    createTrainingWorkflow({
      modelVersionId: 55,
      token: 'tok',
      user: { id: 7, isModerator: false } as never,
      features: {} as never,
      domain: 'green',
    } as never);

  it('refuses it with the model name and the note', async () => {
    status.value = {
      available: true,
      blockedModels: ['krea2'],
      blockedModelReasons: { krea2: 'Provider outage.' },
    };
    await expect(submit()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Krea 2 is temporarily unavailable for training. Provider outage.',
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses it without a note when none is set', async () => {
    status.value = { available: true, blockedModels: ['krea2'] };
    await expect(submit()).rejects.toMatchObject({
      message: 'Krea 2 is temporarily unavailable for training.',
    });
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('passes the gate when nothing is blocked', async () => {
    status.value = { available: true, blockedModels: [] };
    // The next check after the blocked-model gate is the AI Toolkit flag (off in `features`).
    await expect(submit()).rejects.toThrow('AI Toolkit training is not currently enabled');
  });
});
