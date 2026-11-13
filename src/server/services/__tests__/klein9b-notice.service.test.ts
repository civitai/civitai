import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as EmailClient from '~/server/email/client';
import type * as Klein9bNoticeEmail from '~/server/email/templates/klein9bNotice.email';
import { getKlein9bNoticeHtml } from '~/server/email/templates/klein9bNotice.email';
import type { Klein9bUserRow, Klein9bVersionRow } from '~/server/services/klein9b-notice.service';
import {
  classifyKlein9bAudience,
  sendKlein9bNotice,
} from '~/server/services/klein9b-notice.service';

const { sendMock, createNotificationMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  createNotificationMock: vi.fn(),
}));

vi.mock('~/server/email/client', async (importOriginal) => ({
  ...(await importOriginal<typeof EmailClient>()),
  isEmailConfigured: () => true,
}));
vi.mock('~/server/email/templates/klein9bNotice.email', async (importOriginal) => ({
  ...(await importOriginal<typeof Klein9bNoticeEmail>()),
  klein9bNoticeEmail: { send: sendMock },
}));
vi.mock('~/server/notifications/client', () => ({
  notifications: { createNotification: createNotificationMock },
}));

const version = (over: Partial<Klein9bVersionRow>): Klein9bVersionRow => ({
  userId: 1,
  modelName: 'Model',
  versionName: 'v1',
  status: 'Published',
  modelStatus: 'Published',
  private: false,
  licensingFee: null,
  paidAccess: false,
  ...over,
});
const user = (id: number, over: Partial<Klein9bUserRow> = {}): Klein9bUserRow => ({
  id,
  email: `u${id}@example.com`,
  username: `u${id}`,
  bannedAt: null,
  deletedAt: null,
  ...over,
});

describe('classifyKlein9bAudience', () => {
  it('sends the charged notice for a listed version with a fee or open paid access, listing only those', () => {
    const { recipients } = classifyKlein9bAudience(
      [
        version({ userId: 1, modelName: 'A', versionName: 'fee', licensingFee: 5 }),
        version({ userId: 1, modelName: 'A', versionName: 'free' }),
        version({
          userId: 1,
          modelName: 'A',
          versionName: 'gated draft',
          status: 'Draft',
          paidAccess: true,
        }),
        version({ userId: 2, modelName: 'B', versionName: 'gated', paidAccess: true }),
      ],
      [user(1), user(2)]
    );
    expect(recipients.map((r) => [r.id, r.variant, r.versions])).toEqual([
      [1, 'charged', ['A: fee']],
      [2, 'charged', ['B: gated']],
    ]);
  });

  it('ignores deleted, unpublished, draft and private versions and versions on unlisted models: they are not "listed"', () => {
    const { recipients } = classifyKlein9bAudience(
      [
        version({ userId: 1, licensingFee: 5, status: 'Deleted' }),
        version({ userId: 2, paidAccess: true, modelStatus: 'Deleted' }),
        version({ userId: 3, licensingFee: 5, status: 'Unpublished' }),
        version({ userId: 4, paidAccess: true, status: 'Draft' }),
        version({ userId: 5, licensingFee: 5, private: true }),
        version({ userId: 6, private: true }),
        version({ userId: 4 }),
      ],
      [user(1), user(2), user(3), user(4), user(5), user(6)]
    );
    expect(recipients.map((r) => [r.id, r.variant])).toEqual([[4, 'uncharged']]);
  });

  it('sends the uncharged notice only for a published version on a published model, nothing charged', () => {
    const { recipients } = classifyKlein9bAudience(
      [
        version({ userId: 3 }),
        version({ userId: 4, status: 'Draft' }),
        version({ userId: 5, status: 'Unpublished', licensingFee: 0 }),
        version({ userId: 9, modelStatus: 'Draft' }),
      ],
      [user(3), user(4), user(5), user(9)]
    );
    expect(recipients.map((r) => [r.id, r.variant])).toEqual([[3, 'uncharged']]);
  });

  it('skips banned and deleted accounts and counts them', () => {
    const { recipients, excluded } = classifyKlein9bAudience(
      [version({ userId: 6, licensingFee: 5 }), version({ userId: 7 }), version({ userId: 8 })],
      [user(6, { bannedAt: new Date() }), user(7, { deletedAt: new Date() }), user(8)]
    );
    expect(recipients.map((r) => r.id)).toEqual([8]);
    expect(excluded).toBe(2);
  });
});

describe('sendKlein9bNotice', () => {
  it('reports a failed send whose un-recording also failed as stuck, and finishes the run', async () => {
    const ledger = new Map<string, string>();
    dbMock.dbRead.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('').includes('"bannedAt"')
        ? [user(1), user(2), user(3)]
        : [version({ userId: 1 }), version({ userId: 2 }), version({ userId: 3 })]
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
    sys.hDel.mockRejectedValue(new Error('redis down'));
    sys.expireAt.mockResolvedValue(true);
    createNotificationMock.mockResolvedValue(undefined);
    sendMock.mockImplementation(async ({ to }: { to: string }) => {
      if (to === 'u2@example.com') throw new Error('rejected');
    });

    const result = await sendKlein9bNotice({
      dryRun: false,
      count: 50,
      batchSize: 10,
      date: 'November 4th',
    });

    expect(result).toMatchObject({ sent: 2, failedUserIds: [2], stuckUserIds: [2] });
    expect(ledger.has('2')).toBe(true);
  });
});

describe('getKlein9bNoticeHtml', () => {
  it('fills the name, date and the charged versions, escaped', () => {
    const html = getKlein9bNoticeHtml({
      variant: 'charged',
      username: '<b>Ann</b>',
      date: 'November 4th',
      versions: ['My <LoRA>: v2'],
    });
    expect(html).toContain('Hi &lt;b&gt;Ann&lt;/b&gt;,');
    expect(html).toContain('As of November 4th, here');
    expect(html).toContain('<li>My &lt;LoRA&gt;: v2</li>');
    expect(html).toContain('FLUX Non-Commercial License v2.1');
    expect(html).not.toMatch(/\{(username|date|versions)\}/);
  });

  it('the uncharged notice has no version list', () => {
    const html = getKlein9bNoticeHtml({
      variant: 'uncharged',
      username: 'Ann',
      date: 'November 4th',
    });
    expect(html).toContain('Generation earnings stop');
    expect(html).not.toMatch(/\{(username|date|versions)\}/);
  });
});
