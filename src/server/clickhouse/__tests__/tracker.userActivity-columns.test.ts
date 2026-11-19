import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../client';

/**
 * The tracker rejects a whole `userActivities` batch when any row in it carries a key the table has
 * no column for (`Missing columns: 'source'`). `Tracker.userActivity` accepted and sent `source`
 * long before the table had it, so every referral sign-in and pending-review mute took its batch
 * down with it. This pins the relationship: every key the producer can send is a column of the
 * table, either one it already had or one a migration in ../migrations adds.
 */

// The table's columns as read from production before 2026-11-08-user-activities-source.sql.
const BASELINE_COLUMNS = [
  'type',
  'time',
  'userId',
  'targetUserId',
  'ip',
  'userAgent',
  'createdDate',
  'landingPage',
  'deviceId',
];

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

// Comments are stripped first: the migration headers name columns in prose.
const ADD_COLUMN_RE =
  /ALTER\s+TABLE\s+default\.userActivities\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s+([^\n]+)/gi;

const added = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .flatMap((f) => {
    const sql = fs
      .readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    return [...sql.matchAll(ADD_COLUMN_RE)].map((m) => ({
      file: f,
      name: m[1],
      type: m[2].trim(),
    }));
  });

describe('Tracker.userActivity columns', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('a migration adds `source` as a String defaulting to empty', () => {
    const source = added.find((c) => c.name === 'source');
    expect(source?.file).toBe('2026-11-08-user-activities-source.sql');
    expect(source?.type).toMatch(/^String\s+DEFAULT\s+''/);
  });

  it('sends only keys the table has a column for, with every optional field set', async () => {
    const req = { headers: { 'cf-connecting-ip': '203.0.113.9' }, socket: {} };
    const tracker = new Tracker(req as never, {} as never, { user: { id: 42 } } as never);
    await tracker.userActivity({
      type: 'Login',
      targetUserId: 42,
      source: 'referral-x',
      landingPage: '/models',
      time: new Date('2026-11-08T12:00:00.000Z'),
    });
    await new Promise((r) => setImmediate(r));

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://tracker.test/track/userActivities');
    const body = JSON.parse(init.body);
    expect(body.source).toBe('referral-x');

    const columns = new Set([...BASELINE_COLUMNS, ...added.map((c) => c.name)]);
    const unknown = Object.keys(body).filter((k) => !columns.has(k));
    expect(unknown, 'keys the tracker would reject the whole batch for').toEqual([]);
  });
});
