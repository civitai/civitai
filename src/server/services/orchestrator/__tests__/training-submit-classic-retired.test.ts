import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** After the classic trainer's retirement date, its submit refuses every run, moderators' too. */

vi.mock('~/server/services/orchestrator/workflows', () => ({ submitWorkflow: vi.fn() }));
vi.mock('~/server/services/training.service', () => ({
  getTrainingServiceStatus: vi.fn(async () => ({ available: true, blockedModels: [] })),
}));

import { createTrainingWorkflow } from '~/server/services/orchestrator/training/training.orch';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { CLASSIC_TRAINER_RETIRES_AT } from '~/shared/constants/training.constants';

describe('createTrainingWorkflow classic trainer retirement', () => {
  beforeEach(() => {
    setEnv({ WEBHOOK_URL: 'https://webhook.test', WEBHOOK_TOKEN: 't' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(CLASSIC_TRAINER_RETIRES_AT);
  });
  afterEach(() => vi.useRealTimers());

  const submit = (isModerator = false) =>
    createTrainingWorkflow({
      modelVersionId: 55,
      token: 'tok',
      user: { id: 7, isModerator } as never,
      features: {} as never,
      domain: 'green',
    } as never);

  it.each([false, true])('refuses the run (moderator: %s)', async (isModerator) => {
    await expect(submit(isModerator)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/retired/),
    });
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('lets the run through the gate until the retirement instant', async () => {
    vi.setSystemTime(CLASSIC_TRAINER_RETIRES_AT.getTime() - 1);
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);
    await expect(submit()).rejects.toThrow('Invalid model version');
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalled();
  });
});
