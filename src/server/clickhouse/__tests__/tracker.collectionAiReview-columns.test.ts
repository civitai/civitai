import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/env/other', () => ({ isProd: false, isDev: true }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => null),
}));

import { Tracker } from '../client';

/**
 * The tracker rejects a whole batch when a row carries a key its table has no column for. Every
 * key `Tracker.collectionAiReview` sends must be a column `collectionAiReviewEvents` was created
 * with, or one a migration in ../migrations adds.
 */

// The table as created (docs/features/collection-ai-review.md), before any migration.
const BASELINE_COLUMNS = [
  'createdAt',
  'collectionId',
  'collectionItemId',
  'entityId',
  'userId',
  'model',
  'decision',
  'appliedAction',
  'violations',
  'escalations',
  'reason',
  'applied',
  'promptTokens',
  'completionTokens',
];

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
const ALTER_RE =
  /ALTER\s+TABLE\s+default\.collectionAiReviewEvents\b([\s\S]*?)(?=ALTER\s+TABLE|$)/gi;
const ADD_COLUMN_RE = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?/gi;

// Comments are stripped first: the migration headers name columns in prose.
const added = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .flatMap((f) => {
    const sql = fs
      .readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    return [...sql.matchAll(ALTER_RE)].flatMap((alter) =>
      [...alter[1].matchAll(ADD_COLUMN_RE)].map((m) => m[1])
    );
  });

describe('Tracker.collectionAiReview columns', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sends only keys the table has a column for', async () => {
    const req = { headers: {}, socket: {} };
    const tracker = new Tracker(req as never, {} as never, null as never);
    await tracker.collectionAiReview({
      appliedAction: 'accept',
      collectionId: 1,
      collectionItemId: 2,
      entityId: 3,
      userId: -1,
      model: 'm',
      decision: 'approve',
      violations: [],
      escalations: [],
      reason: '',
      applied: true,
      promptTokens: 1,
      completionTokens: 1,
      nsfwLevel: 1,
      minorUncertain: -1,
      depictsMinor: 0,
      isPhotorealistic: 0,
      suggestiveStyling: 0,
      sexualContent: 0,
    });
    await new Promise((r) => setImmediate(r));

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://tracker.test/track/collectionAiReviewEvents');
    const columns = new Set([...BASELINE_COLUMNS, ...added]);
    const unknown = Object.keys(JSON.parse(init.body)).filter((k) => !columns.has(k));
    expect(unknown, 'keys the tracker would reject the whole batch for').toEqual([]);
  });
});
