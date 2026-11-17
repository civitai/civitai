import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { Sleep } from '~/server/services/notice-ledger.service';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import type * as EmailClient from '~/server/email/client';
import type * as NcEarningsNoticeEmail from '~/server/email/templates/ncEarningsNotice.email';
import {
  getNcEarningsNoticeHtml,
  getNcEarningsNoticeSubject,
} from '~/server/email/templates/ncEarningsNotice.email';
import type { NcUserRow, NcVersionRow } from '~/server/services/nc-earnings-notice.service';
import {
  buildNcRecipients,
  sendNcEarningsNotice,
} from '~/server/services/nc-earnings-notice.service';
import { fillNcEarningsCopy } from '~/shared/constants/nc-earnings-notice.constants';
import { ncEarningsNoticeSchema } from '~/server/schema/nc-earnings-notice.schema';

const { sendMock, createNotificationMock, emailConfiguredMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  createNotificationMock: vi.fn(),
  emailConfiguredMock: vi.fn(),
}));

vi.mock('~/server/email/client', async (importOriginal) => ({
  ...(await importOriginal<typeof EmailClient>()),
  isEmailConfigured: () => emailConfiguredMock(),
}));
vi.mock('~/server/email/templates/ncEarningsNotice.email', async (importOriginal) => ({
  ...(await importOriginal<typeof NcEarningsNoticeEmail>()),
  ncEarningsNoticeEmail: { send: sendMock },
}));
vi.mock('~/server/notifications/client', () => ({
  notifications: { createNotification: createNotificationMock },
}));

const version = (over: Partial<NcVersionRow>): NcVersionRow => ({
  userId: 1,
  baseModel: 'Flux.1 Krea',
  modelName: 'Model',
  versionName: 'v1',
  status: 'Published',
  licensingFee: null,
  ...over,
});
const user = (id: number, over: Partial<NcUserRow> = {}): NcUserRow => ({
  id,
  email: `u${id}@example.com`,
  username: `u${id}`,
  bannedAt: null,
  deletedAt: null,
  ...over,
});

describe('fillNcEarningsCopy', () => {
  const text =
    '{baseModels} {is|are} under {a license|licenses} that allow{s|} it.\n- [fee] Fee line.\n- Always.';

  it('uses the singular forms for one base model and drops the fee line without a fee', () => {
    expect(fillNcEarningsCopy(text, ['Flux.1 Krea'], false)).toBe(
      'Flux.1 Krea is under a license that allows it.\n- Always.'
    );
  });

  it('uses the plural forms for several, joined with "and", and keeps the fee line unmarked', () => {
    expect(fillNcEarningsCopy(text, ['Flux.1 Krea', 'Flux.2 D', 'Stable Cascade'], true)).toBe(
      'Flux.1 Krea, Flux.2 D, and Stable Cascade are under licenses that allow it.\n- Fee line.\n- Always.'
    );
  });
});

describe('getNcEarningsNoticeHtml', () => {
  it.each(['nc-recent', 'nc-older'] as const)(
    'the %s email fills every placeholder and escapes what a user chose',
    (notice) => {
      const html = getNcEarningsNoticeHtml({
        notice,
        username: '<b>Ann</b>',
        date: 'November 5th',
        baseModels: ['Qwen 2.1', 'Flux.2 D'],
        versions: ['My <LoRA>: v2'],
      });
      expect(html).toContain('Hi &lt;b&gt;Ann&lt;/b&gt;,');
      expect(html).toContain('As of November 5th:');
      expect(html).not.toMatch(/\{[^}]*\}|\[fee\]/);
    }
  );

  it('lists the fee versions only in the older-bases email, and only when there was a fee', () => {
    const base = { username: 'Ann', date: 'November 5th', baseModels: ['Flux.1 Krea'] };
    const withFee = getNcEarningsNoticeHtml({
      ...base,
      notice: 'nc-older',
      versions: ['A <x>: v1', 'B: v2'],
    });
    expect(withFee).toContain(
      'is no longer charged</strong> on these versions: A &lt;x&gt;: v1, B: v2.'
    );
    expect(getNcEarningsNoticeHtml({ ...base, notice: 'nc-older', versions: [] })).not.toContain(
      'no longer charged'
    );
  });

  it('names the creator’s own base models in the subject', () => {
    expect(getNcEarningsNoticeSubject({ notice: 'nc-older', baseModels: ['Flux.2 D'] })).toBe(
      'Generation earnings have stopped on your Flux.2 D models'
    );
  });
});

describe('buildNcRecipients', () => {
  it('fills each listed creator’s own base models in notice order, and their published fee versions', () => {
    const { recipients } = buildNcRecipients(
      'nc-older',
      [1, 1, 2],
      [
        version({ userId: 1, baseModel: 'Stable Cascade' }),
        version({ userId: 1, baseModel: 'Flux.1 Krea', modelName: 'K', licensingFee: 2 }),
        version({ userId: 1, baseModel: 'Flux.1 Krea', modelName: 'A', licensingFee: 3 }),
        version({
          userId: 1,
          baseModel: 'Flux.2 D',
          versionName: 'draft',
          licensingFee: 2,
          status: 'Draft',
        }),
        version({ userId: 1, baseModel: 'SDXL 1.0', licensingFee: 5 }),
        version({ userId: 2, baseModel: 'Flux.1 Kontext' }),
      ],
      [user(1), user(2)]
    );
    expect(recipients.map((r) => [r.id, r.baseModels, r.versions])).toEqual([
      [1, ['Flux.1 Krea', 'Flux.2 D', 'Stable Cascade'], ['A: v1', 'K: v1']],
      [2, ['Flux.1 Kontext'], []],
    ]);
  });

  it('reports listed ids it cannot send to instead of sending', () => {
    const result = buildNcRecipients(
      'nc-recent',
      [3, 4, 5, 6, 7],
      [
        version({ userId: 3, baseModel: 'Qwen 2.1' }),
        version({ userId: 4, baseModel: 'Qwen 2.1' }),
        version({ userId: 7, baseModel: 'Qwen 2.1' }),
      ],
      [user(3, { bannedAt: new Date() }), user(4), user(5), user(7, { deletedAt: new Date() })]
    );
    expect(result.recipients.map((r) => r.id)).toEqual([4]);
    expect(result.bannedOrDeleted).toEqual([3, 7]);
    expect(result.noVersions).toEqual([5]);
    expect(result.unknown).toEqual([6]);
  });
});

describe('sendNcEarningsNotice', () => {
  const OLDER = REDIS_SYS_KEYS.NOTICES.NC_OLDER_SENT;
  const RECENT = REDIS_SYS_KEYS.NOTICES.NC_RECENT_SENT;
  // Ledger entries keyed by hash key and field, so the two notices' ledgers stay apart.
  let ledger: Map<string, string>;
  const entry = (key: string, id: number) => `${key}|${id}`;
  const versions = [
    version({ userId: 1, licensingFee: 2 }),
    version({ userId: 2, baseModel: 'Flux.2 D' }),
    version({ userId: 3 }),
    version({ userId: 1, baseModel: 'Qwen 2.1' }),
  ];
  beforeEach(() => {
    vi.clearAllMocks();
    ledger = new Map();
    emailConfiguredMock.mockReturnValue(true);
    // The version query interpolates (ids, baseModels); the user query only ids.
    dbMock.dbRead.$queryRaw.mockImplementation(
      async (strings: TemplateStringsArray, ids: number[], bases?: string[]) =>
        strings.join('').includes('"bannedAt"')
          ? [user(1), user(2), user(3, { email: null, username: null })].filter((u) =>
              ids.includes(u.id)
            )
          : versions.filter((v) => ids.includes(v.userId) && bases?.includes(v.baseModel))
    );
    const sys = redisMock.sysRedis;
    sys.hmGet.mockImplementation(async (key: string, fields: string[]) =>
      fields.map((f) => ledger.get(entry(key, Number(f))) ?? null)
    );
    sys.hSetNX.mockImplementation(async (key: string, field: string, value: string) => {
      if (ledger.has(entry(key, Number(field)))) return false;
      ledger.set(entry(key, Number(field)), value);
      return true;
    });
    sys.hDel.mockImplementation(async (key: string, field: string) =>
      ledger.delete(entry(key, Number(field))) ? 1 : 0
    );
    sys.expireAt.mockResolvedValue(true);
    createNotificationMock.mockResolvedValue(undefined);
    sendMock.mockResolvedValue(undefined);
  });
  const run = (over: Partial<Parameters<typeof sendNcEarningsNotice>[0]> = {}) =>
    sendNcEarningsNotice({
      notice: 'nc-older',
      userIds: [1, 2, 3],
      dryRun: false,
      count: 50,
      batchSize: 10,
      date: 'November 5th',
      minIntervalMs: 0,
      ...over,
    });

  it('a dry run sends nothing, records nothing, and counts only the unsent up to `count`', async () => {
    ledger.set(entry(OLDER, 1), 'earlier');
    expect(await run({ dryRun: true })).toMatchObject({
      recipients: 3,
      withFee: 1,
      noEmail: 1,
      alreadySent: 1,
      wouldSend: 2,
    });
    expect(await run({ dryRun: true, count: 1 })).toMatchObject({ wouldSend: 1 });
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(ledger.size).toBe(1);
  });

  it('queries only the listed creators on the notice’s own base models', async () => {
    await run({ dryRun: true });
    const versionCall = dbMock.dbRead.$queryRaw.mock.calls.find(
      ([strings]) => !(strings as TemplateStringsArray).join('').includes('"bannedAt"')
    );
    expect(versionCall?.slice(1)).toEqual([
      [1, 2, 3],
      ['Flux.1 Krea', 'Flux.1 Kontext', 'Flux.2 D', 'Stable Cascade'],
    ]);
  });

  it('notifies every creator, emails those with an address, and words the fee notification only for a fee', async () => {
    expect(await run()).toMatchObject({ sent: 3, failed: 0, remaining: 0 });
    const notices = Object.fromEntries(
      createNotificationMock.mock.calls.map(([n]) => [n.userId, n])
    );
    expect(notices[1]).toEqual({
      userId: 1,
      category: 'System',
      type: 'system-announcement',
      key: 'system-announcement:nc-older-notice:1',
      details: {
        message:
          'Flux.1 Krea is licensed for non-commercial use only, so generation fees and earnings (creator compensation and tips) have stopped for your models on it. They stay published and free to use.',
        url: '/user/u1/models',
      },
    });
    expect(notices[2].details.message).toBe(
      'Flux.2 D is licensed for non-commercial use only, so generation earnings (creator compensation and tips) have stopped for your models on it. They stay published and free to use.'
    );
    expect(notices[3].details.url).toBe('/user/account');
    expect(sendMock.mock.calls.map(([d]) => d.to).sort()).toEqual([
      'u1@example.com',
      'u2@example.com',
    ]);
    expect([...ledger.keys()].sort()).toEqual([entry(OLDER, 1), entry(OLDER, 2), entry(OLDER, 3)]);
    expect(redisMock.sysRedis.expireAt).toHaveBeenCalledWith(
      OLDER,
      new Date('2027-03-01T00:00:00Z')
    );
  });

  it('paces its sends', async () => {
    const sleep = vi.fn<Sleep>(async () => undefined);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await run({ minIntervalMs: 300, sleep });
    } finally {
      now.mockRestore();
    }
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([300, 600]);
  });

  it('sends at most `count` per run', async () => {
    expect(await run({ count: 1 })).toMatchObject({ sent: 1, remaining: 2 });
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a separate ledger per notice: the older notice marks nobody sent the recent one', async () => {
    await run();
    sendMock.mockClear();
    createNotificationMock.mockClear();
    expect(await run({ notice: 'nc-recent' })).toMatchObject({ sent: 1, alreadySent: 0 });
    expect(createNotificationMock.mock.calls.map(([n]) => n.key)).toEqual([
      'system-announcement:nc-recent-notice:1',
    ]);
    expect(ledger.has(entry(RECENT, 1))).toBe(true);
  });

  it('never sends a creator twice, across runs', async () => {
    await run();
    sendMock.mockClear();
    createNotificationMock.mockClear();
    expect(await run()).toMatchObject({ sent: 0, alreadySent: 3 });
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('skips, not sends, a creator a concurrent run claimed after the read', async () => {
    redisMock.sysRedis.hmGet.mockImplementation(async (_key: string, fields: string[]) =>
      fields.map(() => null)
    );
    ledger.set(entry(OLDER, 2), 'other run');
    expect(await run()).toMatchObject({ sent: 2, skipped: 1 });
    expect(createNotificationMock.mock.calls.map(([n]) => n.userId).sort()).toEqual([1, 3]);
  });

  it('records a creator before sending to them', async () => {
    const recordedAtSend: boolean[] = [];
    createNotificationMock.mockImplementation(async ({ userId }: { userId: number }) => {
      recordedAtSend.push(ledger.has(entry(OLDER, userId)));
    });
    await run();
    expect(recordedAtSend).toEqual([true, true, true]);
  });

  it('retries a throttled email without posting the notification again', async () => {
    let throttled = false;
    sendMock.mockImplementation(async ({ to }: { to: string }) => {
      if (to === 'u1@example.com' && !throttled) {
        throttled = true;
        throw Object.assign(new Error('454 Throttling failure: Maximum sending rate exceeded'), {
          responseCode: 454,
        });
      }
    });
    const sleep = vi.fn<Sleep>(async () => undefined);
    expect(await run({ sleep })).toMatchObject({ sent: 3, failed: 0 });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(createNotificationMock.mock.calls.map(([n]) => n.userId).sort()).toEqual([1, 2, 3]);
    expect(sendMock.mock.calls.map(([d]) => d.to).sort()).toEqual([
      'u1@example.com',
      'u1@example.com',
      'u2@example.com',
    ]);
  });

  it('refuses to send, and records nobody, when email is not configured', async () => {
    emailConfiguredMock.mockReturnValue(false);
    await expect(run()).rejects.toThrow('Email is not configured');
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(ledger.size).toBe(0);
  });

  it('un-records a failed send so the next run retries it, and reports a failed un-record as stuck', async () => {
    sendMock.mockImplementation(async ({ to }: { to: string }) => {
      if (to === 'u2@example.com') throw new Error('rejected');
    });
    expect(await run()).toMatchObject({ sent: 2, failedUserIds: [2], stuckUserIds: [] });
    expect(ledger.has(entry(OLDER, 2))).toBe(false);

    redisMock.sysRedis.hDel.mockRejectedValue(new Error('redis down'));
    expect(await run()).toMatchObject({ sent: 0, failedUserIds: [2], stuckUserIds: [2] });
  });
});

describe('ncEarningsNoticeSchema send', () => {
  const send = { action: 'send', notice: 'nc-older', userIds: [1], date: 'November 5th' };

  it('defaults to batchSize 1 and dryRun true', () => {
    expect(ncEarningsNoticeSchema.parse(send)).toMatchObject({ batchSize: 1, dryRun: true });
  });

  it('refuses a batch size over 5', () => {
    expect(ncEarningsNoticeSchema.safeParse({ ...send, batchSize: 5 }).success).toBe(true);
    expect(ncEarningsNoticeSchema.safeParse({ ...send, batchSize: 6 }).success).toBe(false);
  });
});
