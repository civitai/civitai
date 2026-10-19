import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { mockUpsertChat, mockCreateMessage } = vi.hoisted(() => ({
  mockUpsertChat: vi.fn(),
  mockCreateMessage: vi.fn(),
}));
vi.mock('~/server/services/chat.service', () => ({
  upsertChat: mockUpsertChat,
  createMessage: mockCreateMessage,
}));
vi.mock('~/server/services/moderator-app.service', () => ({
  moderatorApp: { abuseReport: vi.fn() },
}));

import { readMinimum, sendWarning } from '~/server/jobs/creator-program-counterparty-review';
import { renderWarningMessage } from '~/server/services/creator-program-counterparty-review/report';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readMinimum', () => {
  it.each([
    [null, null],
    ['', null],
    ['abc', null],
    ['0', null],
    ['-5', null],
    ['1234', 1_234],
  ])('reads %j as %j', async (stored, expected) => {
    redisMock.sysRedis.get.mockResolvedValueOnce(stored);

    expect(await readMinimum()).toBe(expected);
    expect(redisMock.sysRedis.get).toHaveBeenCalledWith(
      REDIS_SYS_KEYS.CREATOR_PROGRAM.COUNTERPARTY_REVIEW_MIN
    );
  });
});

describe('sendWarning', () => {
  it('messages the member from the Civitai account in a 1:1 chat', async () => {
    mockUpsertChat.mockResolvedValueOnce({ id: 77 });

    expect(await sendWarning({ id: 11, username: 'creator' })).toEqual({ chatId: 77 });

    expect(mockUpsertChat).toHaveBeenCalledWith({
      userIds: [-1, 11],
      userId: -1,
      isModerator: true,
    });
    expect(mockCreateMessage).toHaveBeenCalledWith({
      chatId: 77,
      userId: -1,
      isModerator: true,
      contentType: 'Markdown',
      content: renderWarningMessage('creator'),
    });
  });

  it('fails when the chat cannot be opened, so the review retries it', async () => {
    mockUpsertChat.mockRejectedValueOnce(new Error('This user is not accepting chat requests'));

    await expect(sendWarning({ id: 11, username: 'creator' })).rejects.toThrow(
      'not accepting chat requests'
    );
    expect(mockCreateMessage).not.toHaveBeenCalled();
  });
});
