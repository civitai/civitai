import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../client';

const migration = fs.readFileSync(
  path.resolve(__dirname, '../migrations/2026-10-28-image-upload-requests.sql'),
  'utf-8'
);

describe('Tracker.imageUploadRequest', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('writes only the user, IP, key and time, to its own table', async () => {
    const req = { headers: { 'cf-connecting-ip': '203.0.113.9' }, socket: {} };
    const tracker = new Tracker(req as never, {} as never, { user: { id: 42 } } as never);
    await tracker.imageUploadRequest('minted-key');
    await new Promise((r) => setImmediate(r));

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://tracker.test/track/imageUploadRequests');
    expect(JSON.parse(init.body)).toEqual({
      userId: 42,
      ip: '203.0.113.9',
      key: 'minted-key',
      time: expect.any(String),
    });
  });

  // The table the tracker writes above and the one the read query names must be this one.
  it('has a table of exactly those columns, whose rows expire after 12 months', () => {
    const ddl = migration
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('--'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    expect(ddl).toBe(
      'CREATE TABLE IF NOT EXISTS default.imageUploadRequests ( time DateTime64(3) DEFAULT now64(3), userId UInt32, ip String, key String ) ENGINE = MergeTree ORDER BY (userId, time) TTL toDateTime(time) + INTERVAL 12 MONTH;'
    );
  });
});
