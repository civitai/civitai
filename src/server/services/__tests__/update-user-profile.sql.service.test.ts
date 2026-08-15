import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Correctness tests for the SQL statement `updateUserProfile` emits for
// `creatorCardStatsPreferences`.
//
// The statement built its jsonb payload by splicing `JSON.stringify(creatorCardStatsPreferences)`
// into a single-quoted SQL string literal. `JSON.stringify` escapes `"` and `\` but NOT `'`, so a
// preference value holding an apostrophe closed the literal early and the statement stopped
// meaning what it says — the write failed instead of being stored, and the caller got a 500.
// `creatorCardStatsPreferences` is `z.array(z.string()).max(3)` on `userProfileUpdateSchema`, so
// the strings arrive at the statement exactly as the caller sent them.
//
// The statement is now a parameterised tagged template, so values are bound rather than pasted
// into the statement text. These tests assert both halves of that: the statement TEXT is pinned
// literally (so the function, the path and the `::jsonb` cast can't drift), and the user data
// appears only in the bound values.

const { statements, record } = vi.hoisted(() => {
  const statements: { text: string; values: unknown[] }[] = [];

  // Two call shapes reach the capture. The tagged template (`$executeRaw`…``) arrives as
  // `(TemplateStringsArray, ...values)` — NOT a `Prisma.Sql` — and is rebuilt here into
  // `$N`-placeholder text. A pre-built `Prisma.sql` passed as an argument arrives as an object
  // exposing `.sql`/`.values`. The interpolating `$executeRawUnsafe` arrives as one finished
  // string. All three reduce to the same {text, values} pair, so a statement can never go
  // unrecorded and read as a pass.
  const record = (first: any, rest: unknown[]) => {
    if (Array.isArray(first) && Array.isArray(first.raw)) {
      const text = first.reduce(
        (acc: string, chunk: string, i: number) => acc + (i ? `$${i}` : '') + chunk,
        ''
      );
      statements.push({ text, values: rest });
    } else if (first && typeof first === 'object' && typeof first.sql === 'string') {
      statements.push({ text: first.sql, values: Array.isArray(first.values) ? first.values : [] });
    } else {
      statements.push({ text: String(first), values: rest });
    }
  };

  return { statements, record };
});

// dbWrite for everything except the stats read, which `updateUserProfile` takes off dbRead.
// The old fixture handed `$transaction` a SEPARATE `tx` object and then aliased two of its
// tables back onto the client. Prisma's tx client is the same client scoped to a transaction,
// and the canonical `$transaction` models that by passing the node itself — so the separation
// was a distinction the runtime does not have.
const mockDb = dbMock.dbWrite;

mockDb.$executeRaw.mockImplementation(async (first: any, ...rest: unknown[]) => {
  record(first, rest);
  return 1;
});
mockDb.$executeRawUnsafe.mockImplementation(async (first: any, ...rest: unknown[]) => {
  record(first, rest);
  return 1;
});
mockDb.user.findUniqueOrThrow.mockResolvedValue({
  id: 1,
  meta: {},
  settings: {},
  publicSettings: {},
  profile: { userId: 1, message: null, coverImage: null },
});
mockDb.user.findUnique.mockResolvedValue({ id: 1 });
mockDb.userProfile.update.mockResolvedValue({ userId: 1, coverImage: null });
mockDb.userProfile.upsert.mockResolvedValue({ userId: 1 });
mockDb.userLink.deleteMany.mockResolvedValue({ count: 0 });
mockDb.userLink.createMany.mockResolvedValue({ count: 0 });
mockDb.userLink.updateMany.mockResolvedValue({ count: 0 });
// Cover-image ingestion makes a blocking external call; the profile write doesn't depend on it.
vi.mock('~/server/services/image.service', () => ({
  enqueueImageIngestion: vi.fn(async () => undefined),
}));
// Keep the search-index queue (Redis) out of a unit test.
vi.mock('~/server/search-index', () => ({
  usersSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
}));
// The profile-overview caches are Redis-backed and unused on this path.
vi.mock('~/server/redis/caches', () => ({
  getUserContentOverview: vi.fn(async () => ({})),
  getUserContentOverviewPublic: vi.fn(async () => ({})),
  getUserContentOverviewSfw: vi.fn(async () => ({})),
}));

import { updateUserProfile } from '~/server/services/user-profile.service';

const USER_ID = 4242;

// Collapse the statement's indentation so the pin reads as one line. Whitespace between tokens
// is not what these tests are about; the function, the path, the cast and the placeholders are.
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

// The statement this service must emit, pinned literally. Written from what the fix produces,
// not derived from it at runtime: `jsonb_set` (not a `||` merge), the `{creatorCardStatsPreferences}`
// path, `$1` cast to `::jsonb` (not `::text[]`), and `$2` for the id.
const EXPECTED_SQL =
  'UPDATE "User" SET "publicSettings" = jsonb_set( "publicSettings", ' +
  '\'{creatorCardStatsPreferences}\', $1::jsonb ) WHERE "id" = $2';

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;
});

describe('updateUserProfile — the creator-card stats preferences statement', () => {
  it('preserves an apostrophe in a preference value', async () => {
    // A label a user can legitimately store through the profile edit modal.
    const preferences = ["Côte d'Ivoire downloads", 'thumbsUpCount'];

    await updateUserProfile({ userId: USER_ID, creatorCardStatsPreferences: preferences });

    expect(statements).toHaveLength(1);
    const [update] = statements;

    // The value must not appear in the statement text, where an apostrophe would close the
    // surrounding string literal and leave the statement unparseable.
    expect(update.text).not.toContain("d'Ivoire");
    // It must reach the database as a bound parameter instead, byte for byte.
    expect(update.values[0]).toBe(JSON.stringify(preferences));
  });

  it('emits the payload as a bound parameter cast to jsonb', async () => {
    await updateUserProfile({
      userId: USER_ID,
      creatorCardStatsPreferences: ['downloadCount'],
    });

    expect(statements).toHaveLength(1);
    // The whole statement, pinned: nothing user-supplied is inside it, the payload is `$1::jsonb`
    // rather than a quoted literal or another cast, and the target is still a `jsonb_set` of the
    // `{creatorCardStatsPreferences}` key rather than a wholesale column assignment.
    expect(normalize(statements[0].text)).toBe(EXPECTED_SQL);
  });

  it('binds the user id rather than pasting it into the statement', async () => {
    await updateUserProfile({ userId: USER_ID, creatorCardStatsPreferences: ['downloadCount'] });

    const [update] = statements;
    expect(update.values[1]).toBe(USER_ID);
    expect(update.text).not.toContain(String(USER_ID));
  });

  it('binds a value holding a quote, a backslash and a brace without altering it', async () => {
    const preferences = [`a'b"c\\d}e`];

    await updateUserProfile({ userId: USER_ID, creatorCardStatsPreferences: preferences });

    expect(statements).toHaveLength(1);
    const [update] = statements;
    expect(update.values[0]).toBe(JSON.stringify(preferences));
    expect(normalize(update.text)).toBe(EXPECTED_SQL);
  });

  it('sends all three preference entries in one bound payload', async () => {
    // `creatorCardStatsPreferences` is capped at 3 entries; each one must survive intact,
    // in order, including the apostrophe.
    const preferences = ["one's", 'two', 'three'];

    await updateUserProfile({ userId: USER_ID, creatorCardStatsPreferences: preferences });

    const [update] = statements;
    expect(update.values[0]).toBe('["one\'s","two","three"]');
    expect(update.values).toHaveLength(2);
  });

  it('emits no statement when no preferences are given', async () => {
    // Invariant guard, not a regression guard: this branch is unchanged by the fix.
    await updateUserProfile({ userId: USER_ID });

    expect(statements).toHaveLength(0);
  });
});
