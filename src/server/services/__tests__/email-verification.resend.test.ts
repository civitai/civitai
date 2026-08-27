import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('~/server/email/templates/emailVerification.email', () => ({
  emailVerificationEmail: { send: mockSend },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { sendEmailVerification } from '~/server/services/email-verification.service';

const USER_ID = 99;

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue(undefined);
  redisMock.redis.set.mockResolvedValue('OK');
});

describe('sendEmailVerification', () => {
  it('sends to the address already on the account', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      email: 'held@example.test',
      username: 'ada',
      emailVerified: null,
    });

    await expect(sendEmailVerification(USER_ID)).resolves.toMatchObject({ success: true });
    expect(mockSend.mock.calls[0][0]).toMatchObject({ to: 'held@example.test' });
  });

  it('refuses when the address is already verified', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      email: 'held@example.test',
      username: 'ada',
      emailVerified: new Date('2026-01-01T00:00:00Z'),
    });

    await expect(sendEmailVerification(USER_ID)).rejects.toThrow(/already verified/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses when the account has no address', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue({
      email: null,
      username: 'ada',
      emailVerified: null,
    });

    await expect(sendEmailVerification(USER_ID)).rejects.toThrow(/no email address/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses for a user that does not exist', async () => {
    dbMock.dbRead.user.findUnique.mockResolvedValue(null);

    await expect(sendEmailVerification(USER_ID)).rejects.toThrow(/User not found/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
