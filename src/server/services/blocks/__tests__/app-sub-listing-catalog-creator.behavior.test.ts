import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSharedMocks } from '~/__tests__/mocks';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { OnboardingSteps } from '~/server/common/enums';
import type * as AppListingService from '~/server/services/blocks/app-listing.service';
import type * as SharedContentSafety from '~/server/services/apps/shared-content-safety';
import type * as RateLimit from '~/server/utils/shared-storage-rate-limit';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A creator's control over the catalog items an off-site platform listed under their name:
 * the account-settings list and withdraw, and the withdraw that runs when they revoke their
 * consent to the platform's client. Executed on real rows: the sub-listing tables come from the
 * real migrations, the list is the real SQL, and the Prisma writes are translated onto the same
 * database from whatever `where` the service builds, so dropping a predicate changes the rows a
 * statement touches.
 */

const { mockBust, mockTextSafe, mockSyncRate, mockWriteRate, mockGetSessionUser } = vi.hoisted(
  () => ({
    mockBust: vi.fn(async () => undefined),
    mockTextSafe: vi.fn(),
    mockSyncRate: vi.fn(),
    mockWriteRate: vi.fn(),
    mockGetSessionUser: vi.fn(),
  })
);

vi.mock('~/server/services/blocks/app-listing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingService>()),
  bustAppListingCatalogCache: mockBust,
}));
vi.mock('~/server/services/apps/shared-content-safety', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedContentSafety>()),
  assertSharedTextSafe: mockTextSafe,
}));
vi.mock('~/server/utils/shared-storage-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimit>()),
  checkSubListingSyncRateLimit: mockSyncRate,
  checkSubListingWriteRateLimit: mockWriteRate,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (id: number) => mockGetSessionUser(id) },
}));

const {
  findCatalogParentIdsForClient,
  listMyCatalogSubListings,
  moderateSubListing,
  SubListingError,
  upsertCatalogSubListing,
  withdrawCatalogSubListingsForDeletedClient,
  withdrawCatalogSubListingsForRevokedConsent,
  withdrawMyCatalogSubListing,
} = await import('~/server/services/blocks/app-sub-listing.service');

const holder = { db: null as unknown as PGlite };

// ── Prisma → SQL bridge ──────────────────────────────────────────────────────────────────────
// Translates the `where` the service passes, field by field, and refuses any shape it does not
// know, so a test cannot pass on a filter the bridge silently ignored.

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k: string) => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const toCamel = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v]));

function whereSql(where: Record<string, unknown>, values: unknown[]): string {
  const parts = Object.entries(where).flatMap(([key, v]): string[] => {
    // Prisma treats an undefined field as no filter, not as `= NULL`.
    if (v === undefined) return [];
    if (key === 'parentListingId_itemKey') return [whereSql(v as Record<string, unknown>, values)];
    if (key === 'parentListing') {
      return [
        `parent_listing_id IN (SELECT id FROM app_listings WHERE ${whereSql(
          v as Record<string, unknown>,
          values
        )})`,
      ];
    }
    const col = snake(key);
    if (v === null) return [`${col} IS NULL`];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.entries(v as Record<string, unknown>).map(([op, bound]) => {
        if (op === 'not' && bound === null) return `${col} IS NOT NULL`;
        if (op === 'not') {
          values.push(bound);
          return `${col} <> $${values.length}`;
        }
        if (op === 'in') {
          values.push(bound);
          return `${col} = ANY($${values.length})`;
        }
        const ops: Record<string, string> = { gte: '>=', lt: '<' };
        if (!ops[op]) throw new Error(`bridge: unsupported operator ${key}.${op}`);
        values.push(bound);
        return `${col} ${ops[op]} $${values.length}`;
      });
    }
    values.push(v);
    return [`${col} = $${values.length}`];
  });
  if (parts.length === 0) throw new Error('bridge: empty where');
  return parts.join(' AND ');
}

async function selectRows(where: Record<string, unknown>) {
  const values: unknown[] = [];
  const { rows } = await holder.db.query<Record<string, unknown>>(
    `SELECT * FROM app_sub_listings WHERE ${whereSql(where, values)} ORDER BY id`,
    values
  );
  return rows.map(toCamel);
}

function bridgePrisma() {
  const w = dbMock.dbWrite.appSubListing;
  dbMock.dbWrite.appListing.findMany.mockImplementation(
    async (a: { where: Record<string, unknown> }) => {
      const values: unknown[] = [];
      const { rows } = await holder.db.query<Record<string, unknown>>(
        `SELECT * FROM app_listings WHERE ${whereSql(a.where, values)} ORDER BY id`,
        values
      );
      return rows.map(toCamel);
    }
  );
  dbMock.dbRead.$queryRaw.mockImplementation((q: Prisma.Sql) =>
    holder.db.query(q.text, q.values as unknown[]).then((r) => r.rows)
  );
  w.findUnique.mockImplementation(
    async (a: { where: Record<string, unknown> }) => (await selectRows(a.where))[0] ?? null
  );
  w.findFirst.mockImplementation(
    async (a: { where: Record<string, unknown> }) => (await selectRows(a.where))[0] ?? null
  );
  w.count.mockImplementation(
    async (a: { where: Record<string, unknown> }) => (await selectRows(a.where)).length
  );
  w.updateMany.mockImplementation(
    async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const values: unknown[] = [];
      const set = Object.entries(a.data).map(([k, v]) => {
        values.push(v);
        return `${snake(k)} = $${values.length}`;
      });
      const res = await holder.db.query(
        `UPDATE app_sub_listings SET ${set.join(', ')} WHERE ${whereSql(a.where, values)}`,
        values
      );
      return { count: res.affectedRows ?? 0 };
    }
  );
}

// ── Fixture: every id pairwise distinct ──────────────────────────────────────────────────────

const CREATOR = 4101;
const OTHER_AUTHOR = 4202;
const OWNER = 4303;
const CLIENT_A = 'client-alpha';
const CLIENT_B = 'client-beta';
const PARENT_A = 'apl_ALPHA';
const PARENT_B = 'apl_BETA';
const ONSITE = 'apl_ONSITE';
const TEMPLATE_A = 'https://alpha.example.com/?game={id}';
const TEMPLATE_B = 'https://beta.example.com/play/{id}';

// Items of PARENT_A (CLIENT_A) by CREATOR, one per state.
const A_LIVE = 'asl_01JA0000000000000000000A01';
const A_PENDING = 'asl_01JA0000000000000000000A02';
const A_HIDDEN_WAS_LIVE = 'asl_01JA0000000000000000000A03';
const A_HIDDEN_NEVER_LIVE = 'asl_01JA0000000000000000000A04';
const A_WITHDRAWN = 'asl_01JA0000000000000000000A05';
// Same parent and client, another author.
const A_OTHER = 'asl_01JA0000000000000000000A06';
// Another client's parent, same creator.
const B_LIVE = 'asl_01JA0000000000000000000B01';
// An on-site parent, same creator.
const ON_LIVE = 'asl_01JA0000000000000000000C01';
// Hidden after approval, outside the CREATOR + CLIENT_A scope: a revoke must keep their approval.
const A_OTHER_HIDDEN = 'asl_01JA0000000000000000000A07';
const B_HIDDEN = 'asl_01JA0000000000000000000B02';
const ON_HIDDEN = 'asl_01JA0000000000000000000C02';
// The parent's owner's own item (authored without any consent).
const A_OWNERS = 'asl_01JA0000000000000000000A08';
const NOBODY = 4505;

const MIGRATIONS = [
  '20261010120000_app_sub_listings',
  '20261015120000_app_sub_listing_catalog_sync',
].map((m) =>
  path.resolve(
    __dirname,
    `../../../../../packages/civitai-db-schema/prisma/migrations/${m}/migration.sql`
  )
);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "User" ("id" integer PRIMARY KEY);
    CREATE TABLE "Image" ("id" integer PRIMARY KEY);
    CREATE TABLE app_listings (
      id text PRIMARY KEY, kind text NOT NULL, slug text NOT NULL UNIQUE, name text NOT NULL,
      status text NOT NULL, revision_of_id text, connect_client_id text, user_id integer
    );
  `);
  for (const file of MIGRATIONS) await holder.db.exec(readFileSync(file, 'utf8'));
});

afterAll(async () => {
  await holder.db.close();
});

async function seed() {
  await holder.db.exec(`
    TRUNCATE app_sub_listings, app_sub_listing_parents, app_listings, "User" CASCADE;
    INSERT INTO "User" (id) VALUES (${CREATOR}), (${OTHER_AUTHOR}), (${OWNER});
    INSERT INTO app_listings (id, kind, slug, name, status, connect_client_id, user_id) VALUES
      ('${PARENT_A}', 'offsite', 'alpha-games', 'Alpha Games', 'approved', '${CLIENT_A}', ${OWNER}),
      ('${PARENT_B}', 'offsite', 'beta-games', 'Beta Games', 'approved', '${CLIENT_B}', ${OWNER}),
      ('${ONSITE}', 'onsite', 'onsite-app', 'Onsite App', 'approved', '${CLIENT_A}', ${OWNER});
    INSERT INTO app_sub_listing_parents (parent_listing_id, enabled, link_template) VALUES
      ('${PARENT_A}', true, '${TEMPLATE_A}'), ('${PARENT_B}', true, '${TEMPLATE_B}'),
      ('${ONSITE}', true, NULL);
    INSERT INTO app_sub_listings
      (id, parent_listing_id, item_key, author_user_id, title, sub_path, status, approved_at,
       pending_title, pending_sub_path, pending_submitted_at, created_at, updated_at) VALUES
      ('${A_LIVE}', '${PARENT_A}', 'neon-drift', ${CREATOR}, 'Neon Drift', 'neon-drift', 'approved', now(),
       'Neon Drift II', 'neon-drift', now(), now() - interval '8 days', '2026-10-01T00:00:00Z'),
      ('${A_PENDING}', '${PARENT_A}', 'sky-hop', ${CREATOR}, 'Sky Hop', 'sky-hop', 'pending', NULL,
       NULL, NULL, NULL, now() - interval '7 days', '2026-10-01T00:00:00Z'),
      ('${A_HIDDEN_WAS_LIVE}', '${PARENT_A}', 'bad-one', ${CREATOR}, 'Bad One', 'bad-one', 'hidden', now(),
       NULL, NULL, NULL, now() - interval '6 days', '2026-10-01T00:00:00Z'),
      ('${A_HIDDEN_NEVER_LIVE}', '${PARENT_A}', 'bad-two', ${CREATOR}, 'Bad Two', 'bad-two', 'hidden', NULL,
       NULL, NULL, NULL, now() - interval '5 days', '2026-10-01T00:00:00Z'),
      ('${A_WITHDRAWN}', '${PARENT_A}', 'old-one', ${CREATOR}, 'Old One', 'old-one', 'withdrawn', NULL,
       NULL, NULL, NULL, now() - interval '4 days', '2026-10-01T00:00:00Z'),
      ('${A_OTHER}', '${PARENT_A}', 'not-mine', ${OTHER_AUTHOR}, 'Not Mine', 'not-mine', 'approved', now(),
       NULL, NULL, NULL, now() - interval '3 days', '2026-10-01T00:00:00Z'),
      ('${B_LIVE}', '${PARENT_B}', 'beta-run', ${CREATOR}, 'Beta Run', 'beta-run', 'approved', now(),
       NULL, NULL, NULL, now() - interval '2 days', '2026-10-01T00:00:00Z'),
      ('${ON_LIVE}', '${ONSITE}', 'gen-x', ${CREATOR}, 'Gen X', 'g/x', 'approved', now(),
       NULL, NULL, NULL, now() - interval '1 day', '2026-10-01T00:00:00Z'),
      ('${A_OTHER_HIDDEN}', '${PARENT_A}', 'not-mine-2', ${OTHER_AUTHOR}, 'Not Mine 2', 'not-mine-2', 'hidden', now(),
       NULL, NULL, NULL, now() - interval '10 days', '2026-10-01T00:00:00Z'),
      ('${B_HIDDEN}', '${PARENT_B}', 'beta-bad', ${CREATOR}, 'Beta Bad', 'beta-bad', 'hidden', now(),
       NULL, NULL, NULL, now() - interval '11 days', '2026-10-01T00:00:00Z'),
      ('${ON_HIDDEN}', '${ONSITE}', 'gen-bad', ${CREATOR}, 'Gen Bad', 'g/bad', 'hidden', now(),
       NULL, NULL, NULL, now() - interval '12 days', '2026-10-01T00:00:00Z'),
      ('${A_OWNERS}', '${PARENT_A}', 'house-game', ${OWNER}, 'House Game', 'house-game', 'approved', now(),
       NULL, NULL, NULL, now() - interval '13 days', '2026-10-01T00:00:00Z');
  `);
}

type Row = {
  status: string;
  approved_at: Date | null;
  pending_title: string | null;
  pending_sub_path: string | null;
  pending_submitted_at: Date | null;
};
async function rows(): Promise<Record<string, Row>> {
  const { rows } = await holder.db.query<Row & { id: string }>(
    `SELECT id, status, approved_at, pending_title, pending_sub_path, pending_submitted_at
     FROM app_sub_listings`
  );
  return Object.fromEntries(rows.map(({ id, ...r }) => [id, r]));
}
async function statuses(): Promise<Record<string, string>> {
  return Object.fromEntries(Object.entries(await rows()).map(([id, r]) => [id, r.status]));
}
const SEEDED_STATUSES = {
  [A_LIVE]: 'approved',
  [A_PENDING]: 'pending',
  [A_HIDDEN_WAS_LIVE]: 'hidden',
  [A_HIDDEN_NEVER_LIVE]: 'hidden',
  [A_WITHDRAWN]: 'withdrawn',
  [A_OTHER]: 'approved',
  [B_LIVE]: 'approved',
  [ON_LIVE]: 'approved',
  [A_OTHER_HIDDEN]: 'hidden',
  [B_HIDDEN]: 'hidden',
  [ON_HIDDEN]: 'hidden',
  [A_OWNERS]: 'approved',
};
/** Which rows carry an approval (what a moderator restore keys on). */
async function approvals(): Promise<Record<string, boolean>> {
  return Object.fromEntries(
    Object.entries(await rows()).map(([id, r]) => [id, r.approved_at != null])
  );
}
const SEEDED_APPROVALS = {
  [A_LIVE]: true,
  [A_PENDING]: false,
  [A_HIDDEN_WAS_LIVE]: true,
  [A_HIDDEN_NEVER_LIVE]: false,
  [A_WITHDRAWN]: false,
  [A_OTHER]: true,
  [B_LIVE]: true,
  [ON_LIVE]: true,
  [A_OTHER_HIDDEN]: true,
  [B_HIDDEN]: true,
  [ON_HIDDEN]: true,
  [A_OWNERS]: true,
};

async function expectError(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(SubListingError);
  expect(err).toMatchObject({ status, code });
}

beforeEach(async () => {
  resetSharedMocks();
  for (const m of [mockBust, mockTextSafe, mockSyncRate, mockWriteRate, mockGetSessionUser]) {
    m.mockReset();
  }
  bridgePrisma();
  mockWriteRate.mockResolvedValue({ allowed: true });
  mockSyncRate.mockResolvedValue({ allowed: true });
  await seed();
});

describe('listMyCatalogSubListings', () => {
  it("lists only the caller's own items under off-site parents, active first, then newest", async () => {
    const { items } = await listMyCatalogSubListings(CREATOR);
    expect(items.map((i) => i.id)).toEqual([
      B_LIVE,
      A_PENDING,
      A_LIVE,
      A_WITHDRAWN,
      A_HIDDEN_NEVER_LIVE,
      A_HIDDEN_WAS_LIVE,
      B_HIDDEN,
    ]);
    expect(items.find((i) => i.id === A_LIVE)).toEqual({
      id: A_LIVE,
      externalId: 'neon-drift',
      title: 'Neon Drift',
      status: 'approved',
      pendingEdit: true,
      statusReason: null,
      updatedAt: new Date('2026-10-01T00:00:00Z'),
      href: 'https://alpha.example.com/?game=neon-drift',
      parent: {
        id: PARENT_A,
        slug: 'alpha-games',
        name: 'Alpha Games',
        clientId: CLIENT_A,
        isYours: false,
      },
    });
    expect(items.find((i) => i.id === B_LIVE)).toMatchObject({
      href: 'https://beta.example.com/play/beta-run',
      parent: { id: PARENT_B, name: 'Beta Games', clientId: CLIENT_B },
    });
  });

  it("never shows another author's item, and shows that author only their own", async () => {
    const mine = (await listMyCatalogSubListings(CREATOR)).items.map((i) => i.id);
    expect(mine).not.toContain(A_OTHER);
    const theirs = (await listMyCatalogSubListings(OTHER_AUTHOR)).items.map((i) => i.id);
    expect(theirs).toEqual([A_OTHER, A_OTHER_HIDDEN]);
  });

  it('is empty for a user with no items', async () => {
    expect((await listMyCatalogSubListings(NOBODY)).items).toEqual([]);
  });

  it("marks the parent listing as the caller's own when they own it", async () => {
    const { items } = await listMyCatalogSubListings(OWNER);
    expect(items.map((i) => [i.id, i.parent.isYours])).toEqual([[A_OWNERS, true]]);
  });
});

describe('withdrawMyCatalogSubListing', () => {
  it('withdraws an approved item and drops its staged edit', async () => {
    await expect(withdrawMyCatalogSubListing({ userId: CREATOR, id: A_LIVE })).resolves.toEqual({
      ok: true,
      withdrawn: true,
    });
    const after = await rows();
    expect(after[A_LIVE]).toEqual({
      status: 'withdrawn',
      approved_at: expect.any(Date),
      pending_title: null,
      pending_sub_path: null,
      pending_submitted_at: null,
    });
    expect(await statuses()).toEqual({ ...SEEDED_STATUSES, [A_LIVE]: 'withdrawn' });
    // An approved row left the store: the cached page is busted.
    expect(mockBust).toHaveBeenCalledTimes(1);
    expect(mockWriteRate).toHaveBeenCalledWith(CREATOR, PARENT_A);
  });

  it('withdraws a pending item', async () => {
    await withdrawMyCatalogSubListing({ userId: CREATOR, id: A_PENDING });
    expect(await statuses()).toEqual({ ...SEEDED_STATUSES, [A_PENDING]: 'withdrawn' });
  });

  it("refuses another author's item as not found, and changes nothing", async () => {
    await expectError(
      withdrawMyCatalogSubListing({ userId: CREATOR, id: A_OTHER }),
      404,
      'not_found'
    );
    expect(await statuses()).toEqual(SEEDED_STATUSES);
    expect(mockWriteRate).not.toHaveBeenCalled();
  });

  it("refuses the creator's item under an on-site parent (not a catalog item)", async () => {
    await expectError(
      withdrawMyCatalogSubListing({ userId: CREATOR, id: ON_LIVE }),
      404,
      'not_found'
    );
    expect(await statuses()).toEqual(SEEDED_STATUSES);
  });

  it('refuses an unknown id', async () => {
    await expectError(
      withdrawMyCatalogSubListing({ userId: CREATOR, id: 'asl_01JA0000000000000000000Z99' }),
      404,
      'not_found'
    );
  });

  it('never lifts a hide: a hidden item stays hidden, and a restore would go back to review', async () => {
    await expect(
      withdrawMyCatalogSubListing({ userId: CREATOR, id: A_HIDDEN_WAS_LIVE })
    ).resolves.toEqual({ ok: true, withdrawn: false });
    await expect(
      withdrawMyCatalogSubListing({ userId: CREATOR, id: A_HIDDEN_NEVER_LIVE })
    ).resolves.toEqual({ ok: true, withdrawn: false });
    const after = await rows();
    expect(after[A_HIDDEN_WAS_LIVE]).toMatchObject({ status: 'hidden', approved_at: null });
    expect(after[A_HIDDEN_NEVER_LIVE]).toMatchObject({ status: 'hidden', approved_at: null });
    expect(await statuses()).toEqual(SEEDED_STATUSES);
  });

  it('is idempotent: a second withdraw, or one of a withdrawn item, changes nothing', async () => {
    await withdrawMyCatalogSubListing({ userId: CREATOR, id: A_LIVE });
    const { rows: before } = await holder.db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM app_sub_listings WHERE id = $1',
      [A_LIVE]
    );
    await expect(withdrawMyCatalogSubListing({ userId: CREATOR, id: A_LIVE })).resolves.toEqual({
      ok: true,
      withdrawn: false,
    });
    await expect(
      withdrawMyCatalogSubListing({ userId: CREATOR, id: A_WITHDRAWN })
    ).resolves.toEqual({ ok: true, withdrawn: false });
    const { rows: after } = await holder.db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM app_sub_listings WHERE id = $1',
      [A_LIVE]
    );
    expect(after[0].updated_at).toEqual(before[0].updated_at);
    // Only the first call reached a write, so only it was charged.
    expect(mockWriteRate).toHaveBeenCalledTimes(1);
  });

  it('answers 429 when the creator is over the write limit, and changes nothing', async () => {
    mockWriteRate.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });
    await expectError(
      withdrawMyCatalogSubListing({ userId: CREATOR, id: A_LIVE }),
      429,
      'rate_limited'
    );
    expect(await statuses()).toEqual(SEEDED_STATUSES);
  });
});

describe('withdrawCatalogSubListingsForRevokedConsent', () => {
  it("withdraws only that user's active items under that client's parents", async () => {
    await expect(
      withdrawCatalogSubListingsForRevokedConsent({ userId: CREATOR, clientId: CLIENT_A })
    ).resolves.toBe(2);
    expect(await statuses()).toEqual({
      ...SEEDED_STATUSES,
      [A_LIVE]: 'withdrawn',
      [A_PENDING]: 'withdrawn',
    });
    const after = await rows();
    expect(after[A_LIVE]).toMatchObject({
      pending_title: null,
      pending_sub_path: null,
      pending_submitted_at: null,
    });
    // Only CREATOR's hidden item under CLIENT_A loses its approval. Untouched: another author
    // under the same client, the same creator under another client, and the same creator under
    // an on-site listing linked to the same client.
    expect(await approvals()).toEqual({ ...SEEDED_APPROVALS, [A_HIDDEN_WAS_LIVE]: false });
    expect(mockBust).toHaveBeenCalledTimes(1);
  });

  it('keeps hidden items hidden; a moderator restore then sends one back to review', async () => {
    await withdrawCatalogSubListingsForRevokedConsent({ userId: CREATOR, clientId: CLIENT_A });
    const after = await rows();
    expect(after[A_HIDDEN_WAS_LIVE]).toMatchObject({ status: 'hidden', approved_at: null });
    expect(after[A_HIDDEN_NEVER_LIVE]).toMatchObject({ status: 'hidden', approved_at: null });

    // The real moderator restore, on the row as the revoke left it.
    dbMock.dbRead.appListing.findUnique.mockResolvedValue({ kind: 'offsite', appBlock: null });
    const { rows: v } = await holder.db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM app_sub_listings WHERE id = $1',
      [A_HIDDEN_WAS_LIVE]
    );
    await expect(
      moderateSubListing({
        input: { id: A_HIDDEN_WAS_LIVE, action: 'restore', version: v[0].updated_at.toISOString() },
        moderatorId: OWNER,
      })
    ).resolves.toMatchObject({ status: 'pending' });
    expect((await rows())[A_HIDDEN_WAS_LIVE].status).toBe('pending');
  });

  it('a moderator restore of a hidden item the revoke did not reach goes straight back (control)', async () => {
    await withdrawCatalogSubListingsForRevokedConsent({ userId: CREATOR, clientId: CLIENT_A });
    dbMock.dbRead.appListing.findUnique.mockResolvedValue({ kind: 'offsite', appBlock: null });
    const { rows: v } = await holder.db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM app_sub_listings WHERE id = $1',
      [B_HIDDEN]
    );
    await expect(
      moderateSubListing({
        input: { id: B_HIDDEN, action: 'restore', version: v[0].updated_at.toISOString() },
        moderatorId: OWNER,
      })
    ).resolves.toMatchObject({ status: 'approved' });
  });

  it("revoking the other client withdraws only that client's item", async () => {
    await expect(
      withdrawCatalogSubListingsForRevokedConsent({ userId: CREATOR, clientId: CLIENT_B })
    ).resolves.toBe(1);
    expect(await statuses()).toEqual({ ...SEEDED_STATUSES, [B_LIVE]: 'withdrawn' });
    expect(await approvals()).toEqual({ ...SEEDED_APPROVALS, [B_HIDDEN]: false });
  });

  it("another author's revoke touches none of the creator's items", async () => {
    await expect(
      withdrawCatalogSubListingsForRevokedConsent({ userId: OTHER_AUTHOR, clientId: CLIENT_A })
    ).resolves.toBe(1);
    expect(await statuses()).toEqual({ ...SEEDED_STATUSES, [A_OTHER]: 'withdrawn' });
    expect(await approvals()).toEqual({ ...SEEDED_APPROVALS, [A_OTHER_HIDDEN]: false });
  });

  it("the listing owner's revoke leaves the owner's own items (they never needed consent)", async () => {
    await expect(
      withdrawCatalogSubListingsForRevokedConsent({ userId: OWNER, clientId: CLIENT_A })
    ).resolves.toBe(0);
    expect(await statuses()).toEqual(SEEDED_STATUSES);
    expect(await approvals()).toEqual(SEEDED_APPROVALS);
  });

  it('withdraws nothing for a client with no listing', async () => {
    await expect(
      withdrawCatalogSubListingsForRevokedConsent({ userId: CREATOR, clientId: 'client-gamma' })
    ).resolves.toBe(0);
    expect(await statuses()).toEqual(SEEDED_STATUSES);
    expect(await approvals()).toEqual(SEEDED_APPROVALS);
    expect(mockBust).not.toHaveBeenCalled();
  });
});

/**
 * Deleting an OAuth client: its catalog parents' ids are read first, the delete unlinks them
 * (`connect_client_id` → NULL, as the relation's `SetNull` does), then the withdraw runs.
 */
describe('withdrawCatalogSubListingsForDeletedClient', () => {
  async function unlinkClient(clientId: string) {
    await holder.db.query(
      'UPDATE app_listings SET connect_client_id = NULL WHERE connect_client_id = $1',
      [clientId]
    );
  }
  async function deleteClient(clientId: string) {
    const parentListingIds = await findCatalogParentIdsForClient(clientId);
    await unlinkClient(clientId);
    return withdrawCatalogSubListingsForDeletedClient({ parentListingIds });
  }

  it("finds only the client's off-site parents (not an on-site listing linked to it)", async () => {
    await expect(findCatalogParentIdsForClient(CLIENT_A)).resolves.toEqual([PARENT_A]);
    await expect(findCatalogParentIdsForClient(CLIENT_B)).resolves.toEqual([PARENT_B]);
    await expect(findCatalogParentIdsForClient('client-gamma')).resolves.toEqual([]);
  });

  it("withdraws every author's active items under the client's parents, except the owner's", async () => {
    await expect(deleteClient(CLIENT_A)).resolves.toBe(3);
    expect(await statuses()).toEqual({
      ...SEEDED_STATUSES,
      [A_LIVE]: 'withdrawn',
      [A_PENDING]: 'withdrawn',
      [A_OTHER]: 'withdrawn',
    });
    expect((await rows())[A_LIVE]).toMatchObject({
      pending_title: null,
      pending_sub_path: null,
      pending_submitted_at: null,
    });
    // Hidden items stay hidden and lose their approval, for both authors. Untouched: the owner's
    // own item, the other client's parent, and the on-site listing linked to the same client.
    expect(await approvals()).toEqual({
      ...SEEDED_APPROVALS,
      [A_HIDDEN_WAS_LIVE]: false,
      [A_OTHER_HIDDEN]: false,
    });
    expect(mockBust).toHaveBeenCalledTimes(1);
  });

  it('sums across several parents, sparing each parent its own owner', async () => {
    // A second off-site parent on the same client, owned by someone else: there OWNER is just
    // another author, and OTHER_AUTHOR's item is the owner's own.
    const PARENT_A2 = 'apl_ALPHA_TWO';
    const [A2_BY_OWNER, A2_BY_ITS_OWNER, A2_PENDING] = [
      'asl_01JA0000000000000000000D01',
      'asl_01JA0000000000000000000D02',
      'asl_01JA0000000000000000000D03',
    ];
    await holder.db.exec(`
      INSERT INTO app_listings (id, kind, slug, name, status, connect_client_id, user_id) VALUES
        ('${PARENT_A2}', 'offsite', 'alpha-two', 'Alpha Two', 'approved', '${CLIENT_A}', ${OTHER_AUTHOR});
      INSERT INTO app_sub_listing_parents (parent_listing_id, enabled, link_template) VALUES
        ('${PARENT_A2}', true, '${TEMPLATE_A}');
      INSERT INTO app_sub_listings
        (id, parent_listing_id, item_key, author_user_id, title, sub_path, status, approved_at,
         created_at, updated_at) VALUES
        ('${A2_BY_OWNER}', '${PARENT_A2}', 'two-a', ${OWNER}, 'Two A', 'two-a', 'approved', now(),
         now(), '2026-10-01T00:00:00Z'),
        ('${A2_BY_ITS_OWNER}', '${PARENT_A2}', 'two-b', ${OTHER_AUTHOR}, 'Two B', 'two-b', 'approved', now(),
         now(), '2026-10-01T00:00:00Z'),
        ('${A2_PENDING}', '${PARENT_A2}', 'two-c', ${CREATOR}, 'Two C', 'two-c', 'pending', NULL,
         now(), '2026-10-01T00:00:00Z');
    `);
    await expect(deleteClient(CLIENT_A)).resolves.toBe(5);
    expect(await statuses()).toEqual({
      ...SEEDED_STATUSES,
      [A_LIVE]: 'withdrawn',
      [A_PENDING]: 'withdrawn',
      [A_OTHER]: 'withdrawn',
      [A2_BY_OWNER]: 'withdrawn',
      [A2_BY_ITS_OWNER]: 'approved',
      [A2_PENDING]: 'withdrawn',
    });
  });

  it('skips a parent whose owner changed after it was read', async () => {
    const parentListingIds = await findCatalogParentIdsForClient(CLIENT_A);
    await unlinkClient(CLIENT_A);
    // The listing changes hands to CREATOR between the withdraw's parent read and its updates.
    const read = dbMock.dbWrite.appListing.findMany.getMockImplementation()!;
    dbMock.dbWrite.appListing.findMany.mockImplementationOnce(async (a) => {
      const result = await read(a);
      await holder.db.query('UPDATE app_listings SET user_id = $1 WHERE id = $2', [
        CREATOR,
        PARENT_A,
      ]);
      return result;
    });
    await expect(withdrawCatalogSubListingsForDeletedClient({ parentListingIds })).resolves.toBe(0);
    expect(await statuses()).toEqual(SEEDED_STATUSES);
  });

  it("keeps the parent owner's own items live", async () => {
    await deleteClient(CLIENT_A);
    expect((await rows())[A_OWNERS]).toMatchObject({ status: 'approved' });
    expect((await approvals())[A_OWNERS]).toBe(true);
  });

  it("deleting the other client withdraws only that client's items", async () => {
    await expect(deleteClient(CLIENT_B)).resolves.toBe(1);
    expect(await statuses()).toEqual({ ...SEEDED_STATUSES, [B_LIVE]: 'withdrawn' });
    expect(await approvals()).toEqual({ ...SEEDED_APPROVALS, [B_HIDDEN]: false });
  });

  it('withdraws nothing while the parents are still linked (the client delete failed)', async () => {
    const parentListingIds = await findCatalogParentIdsForClient(CLIENT_A);
    expect(parentListingIds).toEqual([PARENT_A]);
    await expect(withdrawCatalogSubListingsForDeletedClient({ parentListingIds })).resolves.toBe(0);
    expect(await statuses()).toEqual(SEEDED_STATUSES);
    expect(await approvals()).toEqual(SEEDED_APPROVALS);
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('withdraws nothing for a client with no catalog parent', async () => {
    await expect(deleteClient('client-gamma')).resolves.toBe(0);
    expect(await statuses()).toEqual(SEEDED_STATUSES);
    expect(await approvals()).toEqual(SEEDED_APPROVALS);
    expect(mockBust).not.toHaveBeenCalled();
  });

  it("a moderator restore of another author's hidden item then sends it back to review", async () => {
    await deleteClient(CLIENT_A);
    dbMock.dbRead.appListing.findUnique.mockResolvedValue({ kind: 'offsite', appBlock: null });
    const { rows: v } = await holder.db.query<{ updated_at: Date }>(
      'SELECT updated_at FROM app_sub_listings WHERE id = $1',
      [A_OTHER_HIDDEN]
    );
    await expect(
      moderateSubListing({
        input: { id: A_OTHER_HIDDEN, action: 'restore', version: v[0].updated_at.toISOString() },
        moderatorId: OWNER,
      })
    ).resolves.toMatchObject({ status: 'pending' });
  });
});

/**
 * Invariant guards, not regression coverage: a PUT of a withdrawn item was already a republish
 * that waits for review. They pin that both new withdraw paths leave the row in that state.
 */
describe('a platform re-publish after a withdraw', () => {
  function user(id: number) {
    return {
      id,
      isModerator: false,
      bannedAt: null,
      muted: false,
      onboarding: OnboardingSteps.Buzz,
      emailVerified: new Date('2020-01-01'),
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    };
  }

  beforeEach(() => {
    dbMock.dbRead.appListing.findFirst.mockResolvedValue({
      id: PARENT_A,
      userId: OWNER,
      contentRating: null,
      subListingParent: { maxPerAuthor: 20, linkTemplate: TEMPLATE_A },
    });
    // The creator has (re-)consented to the platform's client.
    dbMock.dbWrite.oauthConsent.findUnique.mockResolvedValue({ id: 1 });
    mockGetSessionUser.mockImplementation(async (id: number) => user(id));
    mockTextSafe.mockImplementation(async ({ title, body }: { title: string; body?: string }) => ({
      title,
      body,
    }));
  });

  const republish = () =>
    upsertCatalogSubListing({
      parentListingId: PARENT_A,
      clientId: CLIENT_A,
      externalId: 'neon-drift',
      body: { title: 'Neon Drift', creatorUserId: CREATOR },
    });

  it('after the creator withdrew it, goes back to review', async () => {
    await withdrawMyCatalogSubListing({ userId: CREATOR, id: A_LIVE });
    await expect(republish()).resolves.toMatchObject({ id: A_LIVE, status: 'pending' });
    expect((await rows())[A_LIVE]).toMatchObject({ status: 'pending', approved_at: null });
  });

  it('after a consent revoke withdrew it, goes back to review', async () => {
    await withdrawCatalogSubListingsForRevokedConsent({ userId: CREATOR, clientId: CLIENT_A });
    await expect(republish()).resolves.toMatchObject({ id: A_LIVE, status: 'pending' });
    expect((await rows())[A_LIVE]).toMatchObject({ status: 'pending', approved_at: null });
  });
});
