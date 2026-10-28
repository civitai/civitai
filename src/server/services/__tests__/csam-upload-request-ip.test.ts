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
