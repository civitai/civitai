import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetEnv, setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { sendEmail } from '~/server/email/client';
import {
  clearNotificationEmailEnabledCache,
  getEmailUnsubscribeUrl,
  NOTIFICATION_EMAIL_ENABLED_KEY,
  NOTIFICATION_EMAIL_TYPE_HOURLY_CAP,
  NOTIFICATION_EMAIL_USER_DAILY_CAP,
  sendNotificationEmails,
  verifyEmailUnsubscribe,
} from '~/server/services/notification-email.service';
import { getUserEmailSettings, toggleEmailSetting } from '~/server/services/notification.service';
import { emailNotificationTypeList } from '~/server/notifications/utils.notifications';
import { REDIS_SYS_KEYS } from '~/server/redis/client';

vi.mock('~/server/email/client', () => ({ sendEmail: vi.fn(), isEmailConfigured: () => true }));

const DEAL = 'service-deal-requested';
const deal = { type: DEAL, details: { dealId: 7, offeringTitle: 'Portrait' } };

const counters = new Map<string, number>();
let redisDown: false | 'all' | 'user-quota' = false;

beforeEach(() => {
  vi.mocked(sendEmail).mockReset();
  clearNotificationEmailEnabledCache();
  counters.clear();
  redisDown = false;
  dbMock.dbRead.keyValue.findUnique.mockImplementation((async ({ where }: any) =>
    where.key === NOTIFICATION_EMAIL_ENABLED_KEY
      ? { key: where.key, value: true }
      : null) as never);
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ id: 1, email: 'a@example.com' }] as never);
  redisMock.sysRedis.incrBy.mockImplementation((async (key: string, by: number) => {
    if (redisDown === 'all') throw new Error('redis down');
    if (
      redisDown === 'user-quota' &&
      key.startsWith(REDIS_SYS_KEYS.SYSTEM.NOTIFICATION_EMAIL_USER_QUOTA)
    )
      throw new Error('redis down');
    const next = (counters.get(key) ?? 0) + by;
    counters.set(key, next);
    return next;
  }) as never);
});

describe('sendNotificationEmails', () => {
  it('emails a deal notification with a one-click unsubscribe header', async () => {
    const outcome = await sendNotificationEmails({ ...deal, userIds: [1] });
    expect(outcome.sent).toBe(1);
    const mail = vi.mocked(sendEmail).mock.calls[0]![0];
    expect(mail.to).toBe('a@example.com');
    expect(mail.html).toContain('Portrait');
    expect(mail.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail.headers?.['List-Unsubscribe']).toContain('email-unsubscribe');
  });

  it('sends nothing while the KeyValue switch is absent', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null as never);
    const outcome = await sendNotificationEmails({ ...deal, userIds: [1] });
    expect(outcome.skipped).toBe('disabled');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing for a type without defaultEmail, even with the switch on', async () => {
    const outcome = await sendNotificationEmails({
      type: 'new-mention',
      details: {},
      userIds: [1],
    });
    expect(outcome.skipped).toBe('not-email-type');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('stops a user at the daily cap', async () => {
    for (let i = 0; i < NOTIFICATION_EMAIL_USER_DAILY_CAP + 5; i++)
      await sendNotificationEmails({ ...deal, userIds: [1] });
    expect(sendEmail).toHaveBeenCalledTimes(NOTIFICATION_EMAIL_USER_DAILY_CAP);
  });

  it('sends nothing when Redis is down', async () => {
    redisDown = 'all';
    const outcome = await sendNotificationEmails({ ...deal, userIds: [1] });
    expect(outcome.failed).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('escapes user content in the email body', async () => {
    await sendNotificationEmails({
      type: DEAL,
      details: { dealId: 7, offeringTitle: '<script>x</script>' },
      userIds: [1],
    });
    const mail = vi.mocked(sendEmail).mock.calls[0]![0];
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('sends the type its hourly ceiling and stops at the next one', async () => {
    const typeKeyPrefix = `${REDIS_SYS_KEYS.SYSTEM.NOTIFICATION_EMAIL_TYPE_QUOTA}:${DEAL}:`;
    counters.set('type-count', NOTIFICATION_EMAIL_TYPE_HOURLY_CAP - 1);
    const real = redisMock.sysRedis.incrBy.getMockImplementation()!;
    redisMock.sysRedis.incrBy.mockImplementation((async (key: string, by: number) =>
      key.startsWith(typeKeyPrefix) ? real('type-count', by) : real(key, by)) as never);
    await sendNotificationEmails({ ...deal, userIds: [1] });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const outcome = await sendNotificationEmails({ ...deal, userIds: [2] });
    expect(outcome.capped).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('re-arms a cap key that lost its expiry', async () => {
    redisMock.sysRedis.expire.mockClear();
    redisMock.sysRedis.ttl.mockResolvedValue(-1 as never);
    redisMock.sysRedis.incrBy.mockResolvedValue(5 as never);
    await sendNotificationEmails({ ...deal, userIds: [1] });
    // Both keys (type and user) are past their first hit and report no TTL.
    expect(redisMock.sysRedis.expire).toHaveBeenCalledTimes(2);
  });

  it('sends nothing when only the per-user cap cannot be read', async () => {
    redisDown = 'user-quota';
    await sendNotificationEmails({ ...deal, userIds: [1] });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("never logs the recipient's address when a send fails", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error('Email(s) (a@example.com) could not be sent'));
    const outcome = await sendNotificationEmails({ ...deal, userIds: [1] });
    expect(outcome.failed).toBe(1);
    expect(loggingMock.logToAxiom).toHaveBeenCalled();
    expect(JSON.stringify(loggingMock.logToAxiom.mock.calls)).not.toContain('a@example.com');
  });
});

describe('unsubscribe signature', () => {
  const sigOf = (url: string) => new URL(url).searchParams.get('s')!;

  it('without a usable server secret, mails nothing and refuses every link', async () => {
    const sig = sigOf(getEmailUnsubscribeUrl(1, DEAL));
    setEnv({ NEXTAUTH_SECRET: '7-chars' });
    try {
      await sendNotificationEmails({ ...deal, userIds: [1] });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(verifyEmailUnsubscribe(1, DEAL, sig)).toBe(false);
    } finally {
      resetEnv();
    }
  });

  it('accepts its own link and rejects it for another user or type', () => {
    const sig = sigOf(getEmailUnsubscribeUrl(1, DEAL));
    expect(verifyEmailUnsubscribe(1, DEAL, sig)).toBe(true);
    expect(verifyEmailUnsubscribe(2, DEAL, sig)).toBe(false);
    expect(verifyEmailUnsubscribe(1, 'service-deal-paid-out', sig)).toBe(false);
    expect(verifyEmailUnsubscribe(1, DEAL, 'short')).toBe(false);
  });
});

describe('getUserEmailSettings', () => {
  it('a user with no rows gets email for every email type', async () => {
    dbMock.dbWrite.userEmailNotificationOptOut.findMany.mockResolvedValue([] as never);
    const types = await getUserEmailSettings({ userId: 1 });
    expect(types).toContain(DEAL);
    expect(types).toHaveLength(emailNotificationTypeList.length);
  });

  it('an opt-out row turns that one type off', async () => {
    dbMock.dbWrite.userEmailNotificationOptOut.findMany.mockResolvedValue([
      { type: DEAL },
    ] as never);
    const types = await getUserEmailSettings({ userId: 1 });
    expect(types).not.toContain(DEAL);
    expect(types).toHaveLength(emailNotificationTypeList.length - 1);
  });
});

describe('toggleEmailSetting', () => {
  it('turning email off writes the opt-out row', async () => {
    await toggleEmailSetting({ userId: 1, type: [DEAL], enabled: false });
    expect(dbMock.dbWrite.userEmailNotificationOptOut.createMany).toHaveBeenCalledWith({
      data: [{ userId: 1, type: DEAL }],
      skipDuplicates: true,
    });
  });

  it('refuses to record an opt-out for a type that never emails', async () => {
    await expect(
      toggleEmailSetting({ userId: 1, type: ['new-mention'], enabled: false })
    ).rejects.toThrow();
  });

  it('turning email on removes the opt-out row', async () => {
    await toggleEmailSetting({ userId: 1, type: [DEAL], enabled: true });
    expect(dbMock.dbWrite.userEmailNotificationOptOut.deleteMany).toHaveBeenCalledWith({
      where: { userId: 1, type: { in: [DEAL] } },
    });
  });
});
