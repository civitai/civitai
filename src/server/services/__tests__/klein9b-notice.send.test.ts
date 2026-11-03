import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as EmailClient from '~/server/email/client';
import type * as Klein9bNoticeEmail from '~/server/email/templates/klein9bNotice.email';
import type * as NotificationsClient from '~/server/notifications/client';
import { klein9bNoticeSchema } from '~/server/schema/klein9b-notice.schema';
import { KLEIN9B_NOTICE } from '~/shared/constants/klein9b-notice.constants';

const { emailConfiguredMock, sendMock, notifyMock } = vi.hoisted(() => ({
  emailConfiguredMock: vi.fn(),
  sendMock: vi.fn(),
  notifyMock: vi.fn(),
}));

vi.mock('~/server/email/client', async (importOriginal) => ({
  ...(await importOriginal<typeof EmailClient>()),
  isEmailConfigured: emailConfiguredMock,
}));
vi.mock('~/server/email/templates/klein9bNotice.email', async (importOriginal) => ({
  ...(await importOriginal<typeof Klein9bNoticeEmail>()),
  klein9bNoticeEmail: { send: sendMock },
}));
vi.mock('~/server/notifications/client', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsClient>()),
  notifications: { createNotification: notifyMock },
}));

const { sendKlein9bNotice } = await import('~/server/services/klein9b-notice.service');

// User 1 is charged (a fee), user 2 is uncharged (a published free version).
const versions = [
  {
    userId: 1,
    modelName: 'A',
    versionName: 'v1',
    status: 'Published',
    modelStatus: 'Published',
    licensingFee: 5,
    paidAccess: false,
  },
  {
    userId: 2,
    modelName: 'B',
    versionName: 'v1',
    status: 'Published',
    modelStatus: 'Published',
    licensingFee: null,
    paidAccess: false,
  },
];
const users = [1, 2].map((id) => ({
  id,
  email: `u${id}@example.com` as string | null,
  username: `u${id}`,
  bannedAt: null,
  deletedAt: null,
}));

let ledger: Map<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  ledger = new Map();
  sendMock.mockReset().mockResolvedValue(undefined);
  notifyMock.mockReset().mockResolvedValue(undefined);
  emailConfiguredMock.mockReset().mockReturnValue(true);
  dbMock.dbRead.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
    strings.join('').includes('"bannedAt"') ? users : versions
  );
  const sys = redisMock.sysRedis;
  sys.hmGet.mockImplementation(async (_key: string, fields: string[]) =>
    fields.map((f) => ledger.get(f) ?? null)
  );
  sys.hSetNX.mockImplementation(async (_key: string, field: string, value: string) => {
    if (ledger.has(field)) return false;
    ledger.set(field, value);
    return true;
  });
  sys.hDel.mockImplementation(async (_key: string, field: string) =>
    ledger.delete(field) ? 1 : 0
  );
  sys.expireAt.mockResolvedValue(true);
});

const run = (dryRun: boolean) =>
  sendKlein9bNotice({ dryRun, count: 1000, batchSize: 25, date: 'November 4th' });

describe('sendKlein9bNotice', () => {
  it('a dry run only counts: no claim, no notification, no email', async () => {
    expect(await run(true)).toEqual({
      dryRun: true,
      charged: 1,
      uncharged: 1,
      bannedOrDeleted: 0,
      noEmail: 0,
      alreadySent: 0,
      wouldSend: 2,
    });
    expect(redisMock.sysRedis.hSetNX).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends each creator their own variant once, and a re-run sends nothing', async () => {
    expect(await run(false)).toMatchObject({ sent: 2, failed: 0 });
    expect(await run(false)).toMatchObject({ sent: 0, alreadySent: 2, remaining: 0 });

    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 1,
        type: 'system-announcement',
        details: { message: KLEIN9B_NOTICE.charged.message, url: '/user/account' },
      })
    );
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 2,
        details: { message: KLEIN9B_NOTICE.uncharged.message, url: '/user/account' },
      })
    );
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'u1@example.com', variant: 'charged', versions: ['A: v1'] })
    );
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'u2@example.com', variant: 'uncharged', versions: [] })
    );
  });

  it('two runs at once still send each creator once', async () => {
    const [a, b] = await Promise.all([run(false), run(false)]);
    expect([a, b].map((r) => ('sent' in r ? r.sent : 0)).reduce((x, y) => x + y)).toBe(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it('a failed send is un-recorded so the next run retries it; the others stay recorded', async () => {
    sendMock.mockImplementation(async ({ to }: { to: string }) => {
      if (to === 'u2@example.com') throw new Error('smtp down');
    });
    expect(await run(false)).toMatchObject({ sent: 1, failed: 1, failedUserIds: [2] });
    expect([...ledger.keys()]).toEqual(['1']);

    sendMock.mockReset().mockResolvedValue(undefined);
    expect(await run(false)).toMatchObject({ sent: 1, failed: 0 });
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'u2@example.com' }));
  });

  it('a failed notification for a creator with no email is un-recorded and reported, not counted as sent', async () => {
    users[1].email = null;
    notifyMock.mockImplementation(async ({ userId }: { userId: number }) => {
      if (userId === 2) throw new Error('notifications down');
    });
    try {
      expect(await run(false)).toMatchObject({ sent: 1, failed: 1, failedUserIds: [2] });
      expect([...ledger.keys()]).toEqual(['1']);
    } finally {
      users[1].email = 'u2@example.com';
    }
  });

  it('sends at most `count` creators per call, and the next call sends the rest', async () => {
    const first = (await sendKlein9bNotice({
      dryRun: false,
      count: 1,
      batchSize: 25,
      date: 'x',
    })) as {
      sent: number;
      remaining: number;
    };
    expect(first).toMatchObject({ sent: 1, remaining: 1 });
    expect(await run(false)).toMatchObject({ sent: 1, remaining: 0 });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a real send with no email transport, before claiming anyone', async () => {
    emailConfiguredMock.mockReturnValue(false);
    await expect(run(false)).rejects.toThrow('Email is not configured');
    expect(redisMock.sysRedis.hSetNX).not.toHaveBeenCalled();
  });
});

describe('the route schema', () => {
  it('makes a send a dry run unless dryRun: false is passed', () => {
    expect(klein9bNoticeSchema.parse({ action: 'send', date: 'November 4th' })).toMatchObject({
      dryRun: true,
    });
    expect(
      klein9bNoticeSchema.safeParse({ action: 'send', date: 'November 4th', dryRun: 'false' })
        .success
    ).toBe(false);
  });

  it('bounds count to 1-1000 (default 50) and batchSize to 1-50 (default 25)', () => {
    const send = (extra: object) =>
      klein9bNoticeSchema.safeParse({ action: 'send', date: 'November 4th', ...extra });
    expect(send({}).data).toMatchObject({ count: 50, batchSize: 25 });
    expect(send({ count: 1000, batchSize: 50 }).success).toBe(true);
    for (const bad of [{ count: 0 }, { count: 1001 }, { batchSize: 0 }, { batchSize: 51 }])
      expect(send(bad).success).toBe(false);
  });
});
