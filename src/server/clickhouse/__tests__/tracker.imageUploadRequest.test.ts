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

  it('writes a key minted outside a request under the user it was minted for', async () => {
    await new Tracker().imageUploadRequest('job-key', 77);
    await new Promise((r) => setImmediate(r));

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toMatchObject({ userId: 77, key: 'job-key' });
  });

  // A payload column the table lacks is dropped on insert; one the table has but the payload
  // lacks is written as its default.
  it('sends exactly the columns of the table it names, which keeps rows for 12 months', async () => {
    const req = { headers: { 'cf-connecting-ip': '203.0.113.9' }, socket: {} };
    const tracker = new Tracker(req as never, {} as never, { user: { id: 42 } } as never);
    await tracker.imageUploadRequest('minted-key');
    await new Promise((r) => setImmediate(r));
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];

    const [, table, body] =
      migration.match(/CREATE TABLE IF NOT EXISTS default\.(\w+)\s*\(([\s\S]*?)\)\s*ENGINE/) ?? [];
    const columns = (body ?? '')
      .split(',')
      .map((column) => column.trim().split(/\s+/)[0])
      .filter(Boolean);

    expect(url.endsWith(`/track/${table}`)).toBe(true);
    expect(Object.keys(JSON.parse(init.body)).sort()).toEqual([...columns].sort());
    expect(migration).toMatch(/TTL\s+toDateTime\(time\)\s*\+\s*INTERVAL\s+12\s+MONTH/);
  });
});
