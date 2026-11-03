import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
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

const { sendMock, createNotificationMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  createNotificationMock: vi.fn(),
}));

vi.mock('~/server/email/client', async (importOriginal) => ({
  ...(await importOriginal<typeof EmailClient>()),
  isEmailConfigured: () => true,
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
      [1, ['Flux.1 Krea', 'Flux.2 D', 'Stable Cascade'], ['K: v1']],
      [2, ['Flux.1 Kontext'], []],
    ]);
  });

  it('reports listed ids it cannot send to instead of sending', () => {
    const result = buildNcRecipients(
      'nc-recent',
      [3, 4, 5, 6],
      [
        version({ userId: 3, baseModel: 'Qwen 2.1' }),
        version({ userId: 4, baseModel: 'Qwen 2.1' }),
      ],
      [user(3, { bannedAt: new Date() }), user(4), user(5)]
    );
    expect(result.recipients.map((r) => r.id)).toEqual([4]);
    expect(result.bannedOrDeleted).toEqual([3]);
    expect(result.noVersions).toEqual([5]);
    expect(result.unknown).toEqual([6]);
  });
});

describe('sendNcEarningsNotice', () => {
  let ledger: Map<string, string>;
  beforeEach(() => {
    vi.clearAllMocks();
    ledger = new Map();
    dbMock.dbRead.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('').includes('"bannedAt"')
        ? [user(1), user(2), user(3, { email: null })]
        : [
            version({ userId: 1, licensingFee: 2 }),
            version({ userId: 2, baseModel: 'Flux.2 D' }),
            version({ userId: 3 }),
          ]
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
      ...over,
    });

  it('a dry run sends nothing and records nothing', async () => {
    expect(await run({ dryRun: true })).toMatchObject({
      recipients: 3,
      withFee: 1,
      noEmail: 1,
      wouldSend: 3,
    });
    expect(createNotificationMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(ledger.size).toBe(0);
  });

  it('notifies every creator, emails those with an address, and words the fee notification only for a fee', async () => {
    expect(await run()).toMatchObject({ sent: 3, failed: 0 });
    const messages = Object.fromEntries(
      createNotificationMock.mock.calls.map(([n]) => [n.userId, n.details.message])
    );
    expect(messages[1]).toContain('so generation fees and earnings');
    expect(messages[2]).toMatch(/^Flux\.2 D is licensed .* so generation earnings/);
    expect(sendMock.mock.calls.map(([d]) => d.to).sort()).toEqual([
      'u1@example.com',
      'u2@example.com',
    ]);
  });

  it('never sends a creator twice, across runs', async () => {
    await run();
    sendMock.mockClear();
    createNotificationMock.mockClear();
    expect(await run()).toMatchObject({ sent: 0, alreadySent: 3 });
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  it('un-records a failed send so the next run retries it, and reports a failed un-record as stuck', async () => {
    sendMock.mockImplementation(async ({ to }: { to: string }) => {
      if (to === 'u2@example.com') throw new Error('rejected');
    });
    expect(await run()).toMatchObject({ sent: 2, failedUserIds: [2], stuckUserIds: [] });
    expect(ledger.has('2')).toBe(false);

    redisMock.sysRedis.hDel.mockRejectedValue(new Error('redis down'));
    expect(await run()).toMatchObject({ sent: 0, failedUserIds: [2], stuckUserIds: [2] });
  });
});
