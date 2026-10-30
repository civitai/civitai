import { beforeEach, describe, expect, it, vi } from 'vitest';

const ch = vi.hoisted(() => ({ query: vi.fn(), request: vi.fn() }));
vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  clickhouse: { $query: ch.query },
  Tracker: vi.fn(function () {
    return { imageUploadRequest: ch.request };
  }),
}));

import type { NextApiRequest, NextApiResponse } from 'next';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import {
  getImageUploadIpEvents,
  recordMintedUploadKey,
  trackImageUpload,
} from '~/server/services/image-upload-action.service';

const OWNER = 42;
const CREATED = new Date('2026-10-20T12:00:00.000Z');
const sql = () => ch.query.mock.calls[0]?.[0] as string;

beforeEach(() => {
  vi.clearAllMocks();
  ch.request.mockResolvedValue(undefined);
  dbMock.dbRead.image.findMany.mockResolvedValue([
    { id: 1, url: 'key-one', createdAt: CREATED },
    { id: 2, url: "key-'two", createdAt: new Date(CREATED.getTime() + 3_600_000) },
  ] as never);
  ch.query.mockResolvedValue([
    { ip: '203.0.113.5', key: 'key-one', time: '2026-10-20 11:59:00' },
    { ip: '203.0.113.6', key: "key-'two", time: '2026-10-20 12:59:00' },
    // A key none of the asked images carries is not theirs.
    { ip: '198.51.100.1', key: 'someone-else', time: '2026-10-20 12:00:00' },
  ]);
});

describe('getImageUploadIpEvents', () => {
  it('gives each image the IP that requested its upload key, as an Upload event', async () => {
    const events = await getImageUploadIpEvents({ userId: OWNER, imageIds: [1, 2] });

    expect(events).toEqual([
      {
        ip: '203.0.113.5',
        time: '2026-10-20 11:59:00',
        type: 'Upload',
        details: { type: 'image-upload-request', id: 1 },
      },
      {
        ip: '203.0.113.6',
        time: '2026-10-20 12:59:00',
        type: 'Upload',
        details: { type: 'image-upload-request', id: 2 },
      },
    ]);
  });

  it("asks only for this user's upload actions on these keys, in the window before each was created", async () => {
    await getImageUploadIpEvents({ userId: OWNER, imageIds: [1, 2] });

    expect(dbMock.dbRead.image.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [1, 2] } } })
    );
    expect(sql()).toMatch(/FROM imageUploadRequests\s+WHERE userId = 42\s/);
    expect(sql()).toContain(
      "time BETWEEN parseDateTimeBestEffort('2026-10-19T12:00:00.000Z') AND parseDateTimeBestEffort('2026-10-20T14:00:00.000Z')"
    );
    // The keys are quoted and escaped: `$query` interpolates raw.
    expect(sql()).toContain("key IN ('key-one','key-\\'two')");
  });

  it('asks nothing when there are no images or no user', async () => {
    expect(await getImageUploadIpEvents({ userId: OWNER, imageIds: [] })).toEqual([]);
    expect(await getImageUploadIpEvents({ userId: 0, imageIds: [1, 2] })).toEqual([]);
    dbMock.dbRead.image.findMany.mockResolvedValue([] as never);
    expect(await getImageUploadIpEvents({ userId: OWNER, imageIds: [9] })).toEqual([]);

    expect(ch.query).not.toHaveBeenCalled();
  });
});

describe('trackImageUpload', () => {
  const req = {} as NextApiRequest;
  const res = {} as NextApiResponse;

  it('records the minted key as an upload request', () => {
    trackImageUpload(req, res, 'minted-key');

    expect(ch.request).toHaveBeenCalledExactlyOnceWith('minted-key');
  });

  it('never throws when tracking fails, and logs it', async () => {
    ch.request.mockRejectedValue(new Error('tracker down'));

    expect(() => trackImageUpload(req, res, 'minted-key')).not.toThrow();
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'image-upload-action', error: 'tracker down' })
      )
    );
  });
});

describe('recordMintedUploadKey', () => {
  it('records the key for the user in the issue record and in the upload request log', async () => {
    await recordMintedUploadKey('Server-Key', OWNER);

    expect(redisMock.sysRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('server-key'),
      String(OWNER),
      expect.anything()
    );
    expect(ch.request).toHaveBeenCalledExactlyOnceWith('Server-Key', OWNER);
  });

  it("logs through the request's tracker when it has one, so the row keeps its IP", async () => {
    const request = vi.fn(async () => true);
    await recordMintedUploadKey('server-key', OWNER, { imageUploadRequest: request } as never);

    expect(request).toHaveBeenCalledExactlyOnceWith('server-key', OWNER);
    expect(ch.request).not.toHaveBeenCalled();
  });

  it('never throws when the request log fails, and logs it', async () => {
    ch.request.mockRejectedValue(new Error('tracker down'));

    await expect(recordMintedUploadKey('server-key', OWNER)).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'image-upload-action', error: 'tracker down' })
      )
    );
  });
});
