import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BlocklistService from '~/server/services/blocklist.service';

// Empty blocklists, so only the reserved-name check can refuse: the static list's `civit` entry would
// otherwise refuse every case here on its own.
vi.mock('~/utils/blocklist-username.json', () => ({ default: { exact: [], partial: [] } }));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  getBlocklistData: vi.fn(async () => []),
}));
vi.mock('~/server/recaptcha/client', () => ({ verifyCaptchaToken: vi.fn(async () => true) }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import {
  completeOnboardingHandler,
  getUsernameAvailableHandler,
  updateUserHandler,
} from '~/server/controllers/user.controller';
import { isUsernamePermitted } from '~/server/services/username-permitted';

const USER_ID = 4242;
const ctx = { user: { id: USER_ID } } as never;
const RESERVED = [
  'CivitaiModeration',
  'civitaimoderation',
  'Civ1taiModeration',
  'Civitai_Moderation',
  'CivitaiModerat\u0456on',
  'Civitai\u200bModeration',
];

const available = (username: string) =>
  getUsernameAvailableHandler({ input: { username }, ctx } as never);
const rename = (username: string) =>
  updateUserHandler({ input: { id: USER_ID, username }, ctx } as never);
const onboard = (username: string) =>
  completeOnboardingHandler({
    input: { step: OnboardingSteps.Profile, username, email: 'a@example.test' },
    ctx,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.user.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.user.findFirst.mockResolvedValue(null);
});

describe('self-service usernames and the reserved moderation username', () => {
  it.each(RESERVED)('refuses %j everywhere a user picks a name', async (username) => {
    expect(await isUsernamePermitted(username)).toBe(false);
    expect(await available(username)).toBe(false);
    await expect(rename(username)).rejects.toThrow('Invalid username');
    await expect(onboard(username)).rejects.toThrow('Invalid username');
    expect(dbMock.dbWrite.user.update).not.toHaveBeenCalled();
  });

  it('still permits ordinary names, and names that only share a word with it', async () => {
    for (const username of ['ada', 'CivitaiModerator', 'Moderation', 'ModerationFan'])
      expect(await isUsernamePermitted(username)).toBe(true);
    expect(await available('ada')).toBe(true);
  });
});
