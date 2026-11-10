import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as UserService from '~/server/services/user.service';

const { mockDeleteBasicData } = vi.hoisted(() => ({ mockDeleteBasicData: vi.fn() }));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  deleteBasicDataForUser: mockDeleteBasicData,
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  assertEmailAllowed: vi.fn(async () => undefined),
}));
vi.mock('~/server/email/templates/emailVerification.email', () => ({
  emailVerificationEmail: { send: vi.fn(async () => undefined) },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { OnboardingSteps, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { completeOnboardingHandler } from '~/server/controllers/user.controller';
import { usersSearchIndex } from '~/server/search-index';

const USER_ID = 4242;
const EMAIL = 'ada@example.test';

const queueUpdate = vi.spyOn(usersSearchIndex, 'queueUpdate');

function runProfile(username: string) {
  return completeOnboardingHandler({
    input: { step: OnboardingSteps.Profile, username, email: EMAIL },
    ctx: { user: { id: USER_ID, onboarding: 0, email: EMAIL }, domain: 'blue' },
  } as unknown as Parameters<typeof completeOnboardingHandler>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeleteBasicData.mockResolvedValue(undefined);
  queueUpdate.mockResolvedValue(undefined as never);
  dbMock.dbWrite.user.update.mockResolvedValue({ id: USER_ID });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1);
  dbMock.dbRead.user.findFirst.mockResolvedValue(null);
  redisMock.redis.set.mockResolvedValue('OK');
});

describe('onboarding Profile step — username propagation', () => {
  it('refreshes the basic-user cache and re-queues the user search document on a rename', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({
      email: EMAIL,
      emailVerified: new Date(),
      username: null,
    });

    await runProfile('ada');

    expect(mockDeleteBasicData).toHaveBeenCalledWith(USER_ID);
    expect(queueUpdate).toHaveBeenCalledWith([
      { id: USER_ID, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });

  it('does neither when the username is unchanged', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({
      email: EMAIL,
      emailVerified: new Date(),
      username: 'ada',
    });

    await runProfile('ada');

    expect(mockDeleteBasicData).not.toHaveBeenCalled();
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('still completes the committed step when the cache refresh and enqueue both fail', async () => {
    dbMock.dbWrite.user.findUnique.mockResolvedValue({
      email: EMAIL,
      emailVerified: new Date(),
      username: null,
    });
    mockDeleteBasicData.mockRejectedValue(new Error('redis down'));
    queueUpdate.mockRejectedValue(new Error('redis down'));

    await expect(runProfile('ada')).resolves.not.toThrow();
    expect(dbMock.dbWrite.user.update).toHaveBeenCalledTimes(1);
  });
});
