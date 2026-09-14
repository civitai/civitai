import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  CollectionContributorPermission,
  CollectionItemStatus,
  CollectionMode,
} from '~/shared/utils/prisma/enums';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a
// contended runner. Relaxing it can only help a slow box, never mask a failure.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = { db: null as unknown as PGlite };

dbMock.dbRead.$queryRaw.mockImplementation(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return holder.db.query(flat.text, flat.values as unknown[]).then((r) => r.rows);
  }
);

const { getPendingCollectionReviewCounts } = await import('~/server/services/collection.service');

const OWNER = 100;
const MANAGER = 101; // holds MANAGE on someone else's collection
const FOLLOWER = 102; // holds VIEW + ADD on someone else's collection, never MANAGE
const STRANGER = 103;

const OWNED_WITH_QUEUE = 9001;
const OWNED_EMPTY = 9002; // owned, but every item already decided
const OWNED_CONTEST = 9003; // 🔴 the mode canary
const MANAGED = 9004; // owned by OWNER, MANAGER holds MANAGE
const FOLLOWED = 9005; // owned by OWNER, FOLLOWER holds VIEW + ADD

beforeAll(async () => {
  holder.db = new PGlite();
  // Real enum types, not text stand-ins: the statement casts to these, and a text
  // column would accept casts Postgres rejects on the enum.
  await holder.db.exec(`
    CREATE TYPE "CollectionItemStatus" AS ENUM (${Object.values(CollectionItemStatus)
      .map((s) => `'${s}'`)
      .join(', ')});
    CREATE TYPE "CollectionContributorPermission" AS ENUM (${Object.values(
      CollectionContributorPermission
    )
      .map((p) => `'${p}'`)
      .join(', ')});
    CREATE TYPE "CollectionMode" AS ENUM (${Object.values(CollectionMode)
      .map((m) => `'${m}'`)
      .join(', ')});

    CREATE TABLE "Collection" (
      "id"     integer PRIMARY KEY,
      "userId" integer NOT NULL,
      "mode"   "CollectionMode"
    );
    CREATE TABLE "CollectionContributor" (
      "userId"       integer NOT NULL,
      "collectionId" integer NOT NULL,
      "permissions"  "CollectionContributorPermission"[] NOT NULL,
      PRIMARY KEY ("userId", "collectionId")
    );
    CREATE TABLE "CollectionItem" (
      "id"           integer PRIMARY KEY,
      "collectionId" integer NOT NULL,
      "status"       "CollectionItemStatus" NOT NULL DEFAULT 'ACCEPTED'
    );

    INSERT INTO "Collection" ("id","userId","mode") VALUES
      (${OWNED_WITH_QUEUE}, ${OWNER}, NULL),
      (${OWNED_EMPTY},      ${OWNER}, NULL),
      (${OWNED_CONTEST},    ${OWNER}, 'Contest'),
      (${MANAGED},          ${OWNER}, NULL),
      (${FOLLOWED},         ${OWNER}, NULL);

    INSERT INTO "CollectionContributor" ("userId","collectionId","permissions") VALUES
      -- A real co-manager. Carries VIEW too, matching every such row on prod.
      (${MANAGER},  ${MANAGED},  ARRAY['VIEW','MANAGE']::"CollectionContributorPermission"[]),
      -- Elevated, but not to MANAGE. Must count nothing.
      (${FOLLOWER}, ${FOLLOWED}, ARRAY['VIEW','ADD']::"CollectionContributorPermission"[]);

    INSERT INTO "CollectionItem" ("id","collectionId","status") VALUES
      (1, ${OWNED_WITH_QUEUE}, 'REVIEW'),
      (2, ${OWNED_WITH_QUEUE}, 'REVIEW'),
      (3, ${OWNED_WITH_QUEUE}, 'ACCEPTED'),
      (4, ${OWNED_WITH_QUEUE}, 'REJECTED'),
      (5, ${OWNED_EMPTY},      'ACCEPTED'),
      (6, ${OWNED_EMPTY},      'REJECTED'),
      (7, ${OWNED_CONTEST},    'REVIEW'),
      (8, ${MANAGED},          'REVIEW'),
      (9, ${MANAGED},          'REVIEW'),
      (10, ${MANAGED},         'REVIEW'),
      (11, ${FOLLOWED},        'REVIEW');
  `);
});

describe('getPendingCollectionReviewCounts', () => {
  it('counts REVIEW rows in owned collections and nothing else', async () => {
    const { total, byCollection } = await getPendingCollectionReviewCounts({ userId: OWNER });

    // 2 in OWNED_WITH_QUEUE + 1 in OWNED_CONTEST + 3 in MANAGED + 1 in FOLLOWED,
    // all five owned by OWNER. ACCEPTED and REJECTED rows contribute nothing.
    expect(byCollection[OWNED_WITH_QUEUE]).toBe(2);
    expect(total).toBe(7);
  });

  it('omits a collection with nothing pending rather than reporting zero', async () => {
    // Absence, not a 0 entry: the sidebar reads `?? 0`, and a present zero would
    // make QueueCountBadge's own "a zero draws nothing" rule the only thing
    // standing between an empty queue and a badge.
    const { byCollection } = await getPendingCollectionReviewCounts({ userId: OWNER });

    expect(byCollection[OWNED_EMPTY]).toBeUndefined();
  });

  it('counts a Contest collection like any other', async () => {
    // 🔴 The mode canary. 96% of everything pending on prod is Contest mode, and
    // the same /review page reviews it. A `mode` filter added here would look
    // like a reasonable narrowing and would silently blank the badge for almost
    // every queue that actually exists.
    const { byCollection } = await getPendingCollectionReviewCounts({ userId: OWNER });

    expect(byCollection[OWNED_CONTEST]).toBe(1);
  });

  it('counts a collection the user manages but does not own', async () => {
    const { total, byCollection } = await getPendingCollectionReviewCounts({ userId: MANAGER });

    expect(byCollection[MANAGED]).toBe(3);
    expect(total).toBe(3);
  });

  it('counts nothing for a contributor without MANAGE', async () => {
    // FOLLOWER holds VIEW and ADD on a collection with a pending row. A
    // permission test that checks for "any contributor row" — or one that
    // overlaps the array instead of testing membership — passes every other
    // case in this file and fails only here.
    const { total, byCollection } = await getPendingCollectionReviewCounts({ userId: FOLLOWER });

    expect(byCollection).toEqual({});
    expect(total).toBe(0);
  });

  it('counts nothing for a user with no collections at all', async () => {
    const { total, byCollection } = await getPendingCollectionReviewCounts({ userId: STRANGER });

    expect(total).toBe(0);
    expect(byCollection).toEqual({});
  });
});
