import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ClickhouseClient from '~/server/clickhouse/client';
import type * as ImageUploadAction from '~/server/services/image-upload-action.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const m = vi.hoisted(() => ({ query: vi.fn(), uploadEvents: vi.fn() }));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseClient>()),
  clickhouse: { $query: m.query },
}));
vi.mock('~/server/services/image-upload-action.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUploadAction>()),
  getImageUploadIpEvents: m.uploadEvents,
}));

import * as csamLegacy from '~/server/services/csam.service';
import * as csamNew from '~/server/services/csam.service-new';
import { UPLOAD_REQUEST_IP_NOTE } from '~/server/services/image-upload-action.service';

const login = { ip: '192.0.2.1', type: 'Login', time: '2026-10-20 10:00:00' };
const uploadRequest = {
  ip: '203.0.113.5',
  time: '2026-10-20 11:59:00',
  type: 'Upload',
  details: { type: 'image-upload-request', id: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.query.mockResolvedValue([login]);
  m.uploadEvents.mockResolvedValue([uploadRequest]);
  dbMock.dbRead.image.findMany.mockResolvedValue([] as never);
});

describe.each([
  ['csam.service', csamLegacy.getUserIpInfo],
  ['csam.service-new', csamNew.getUserIpInfo],
])('%s getUserIpInfo', (_, getUserIpInfo) => {
  it("adds each reported image's upload-request IP to an image report", async () => {
    const events = await getUserIpInfo({ userId: 42, type: 'Image', images: [{ id: 1 }] as never });

    expect(m.uploadEvents).toHaveBeenCalledExactlyOnceWith({ userId: 42, imageIds: [1] });
    expect(events).toEqual([login, uploadRequest]);
  });

  it('looks up no upload-request IPs for a report that is not about images', async () => {
    const events = await getUserIpInfo({ userId: 42, type: 'TrainingData', details: {} });

    expect(m.uploadEvents).not.toHaveBeenCalled();
    expect(events).toEqual([login]);
  });

  // Sign-ins are written with the signed-in account in targetUserId, and userId is usually 0.
  // A row whose userId differs from targetUserId is one account acting on another.
  describe('sign-in IPs', () => {
    const row = (userId: number, targetUserId: number, ip: string, type: string) => ({
      userId,
      targetUserId,
      ip,
      type,
      time: '2026-10-20 09:00:00',
    });
    const activities = [
      row(0, 42, '192.0.2.10', 'Login'),
      row(0, 42, '192.0.2.11', 'Registration'),
      row(42, 99, '192.0.2.12', 'Registration'), // 42 acting on account 99
      row(42, 42, '192.0.2.13', 'Login'), // 42 is both actor and target
      row(0, 7, '198.51.100.7', 'Login'), // another account's sign-in
      row(7, 99, '198.51.100.8', 'Login'), // another account acting on another account
    ];
    // Runs the userActivities query against the rows above: its WHERE clause as a predicate, and
    // only the columns it SELECTs, so a column the query reads comes back exactly as it would.
    function userActivitiesTable(sql: string) {
      const match = /SELECT([\s\S]+?)FROM userActivities\s+WHERE([\s\S]+)$/.exec(sql);
      if (!match) return [];
      const columns = match[1].split(',').map((c) => c.trim());
      const where = match[2]
        .replace(/!=/g, '!==')
        .replace(/(?<![!=])=(?!=)/g, '===')
        .replace(/\bAND\b/g, '&&')
        .replace(/\bOR\b/g, '||')
        .replace(/\b(userId|targetUserId|type)\b/g, 'r.$1');
      const keep = new Function('r', `return ${where};`) as (r: object) => boolean;
      return activities
        .filter(keep)
        .map((r) => Object.fromEntries(columns.map((c) => [c, (r as Record<string, unknown>)[c]])));
    }

    beforeEach(() => {
      m.query.mockImplementation(async (sql: string) => userActivitiesTable(sql));
    });

    it("returns the reported account's own sign-ins, and each row once", async () => {
      const events = await getUserIpInfo({ userId: 42, type: 'TrainingData', details: {} });

      expect(events.map((e) => e.ip).sort()).toEqual([
        '192.0.2.10',
        '192.0.2.11',
        '192.0.2.12',
        '192.0.2.13',
      ]);
    });

    it('includes its activity on another account without naming that account', async () => {
      const events = await getUserIpInfo({ userId: 42, type: 'TrainingData', details: {} });

      expect(events).toContainEqual({
        ip: '192.0.2.12',
        type: 'Registration',
        time: '2026-10-20 09:00:00',
      });
      expect(JSON.stringify(events)).not.toContain('99');
    });

    it("never returns another account's activity (control)", async () => {
      const events = await getUserIpInfo({ userId: 42, type: 'TrainingData', details: {} });

      expect(events.map((e) => e.ip)).not.toContain('198.51.100.7');
      expect(events.map((e) => e.ip)).not.toContain('198.51.100.8');
    });
  });
});

describe('getCsamReportsPaged', () => {
  it('lists reports without the IP events kept on them', async () => {
    dbMock.dbRead.csamReport.findMany.mockResolvedValue([
      {
        id: 1,
        userId: 42,
        reportedById: 10,
        details: { userActivity: [login], minorDepiction: 'real' },
      },
    ] as never);
    dbMock.dbRead.user.findMany.mockResolvedValue([] as never);
    dbMock.dbRead.csamReport.count.mockResolvedValue(1);

    const { items } = await csamLegacy.getCsamReportsPaged({ limit: 10, page: 1 });

    expect(items[0].details).toEqual({ minorDepiction: 'real' });
  });
});

describe('getReportedUserAdditionalInfo', () => {
  it('explains the upload IPs when the report carries an upload-request event', () => {
    expect(
      csamNew.getReportedUserAdditionalInfo('user@example.invalid', [uploadRequest as never])
    ).toBe(`Email: user@example.invalid\n${UPLOAD_REQUEST_IP_NOTE}`);
    expect(csamNew.getReportedUserAdditionalInfo(null, [uploadRequest as never])).toBe(
      UPLOAD_REQUEST_IP_NOTE
    );
  });

  it('adds no note without an upload-request event', () => {
    expect(csamNew.getReportedUserAdditionalInfo('user@example.invalid', [login as never])).toBe(
      'Email: user@example.invalid'
    );
    expect(csamNew.getReportedUserAdditionalInfo(null, [login as never])).toBeUndefined();
  });
});
