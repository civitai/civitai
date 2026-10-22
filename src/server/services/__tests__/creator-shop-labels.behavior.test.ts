import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type { CosmeticShopItemHistoryEntry } from '~/server/schema/cosmetic-shop.schema';
import { bootLabelStore } from '~/server/services/__tests__/label-store.fixture';

// The committed label-store migrations on real Postgres: a mocked statement can't show that a label
// lands on the right subject, that a retry records nothing twice, or that a store failure leaves the
// verdict standing.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const ATTACH_BYTES = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261124120000_label_store_attach_bytes/migration.sql'
);

const db = { pg: null as unknown as PGlite };
const statementTimeouts: string[] = [];
const toSql = (strings: TemplateStringsArray, values: unknown[]) =>
  Prisma.sql(strings, ...(values as never[]));
const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { text, values: params } = toSql(strings, values);
    if (text.includes('label_store.record_label('))
      statementTimeouts.push(
        (await db.pg.query<{ statement_timeout: string }>('SHOW statement_timeout')).rows[0]
          .statement_timeout
      );
    return (await db.pg.query(text, params as unknown[])).rows;
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const { text, values: params } = toSql(strings, values);
    return (await db.pg.query(text, params as unknown[])).affectedRows ?? 0;
  },
};
// dbWrite's transactions run on the same Postgres, one at a time.
async function inTransaction<T>(fn: (client: typeof tx) => Promise<T>) {
  await db.pg.exec('BEGIN');
  try {
    const result = await fn(tx);
    await db.pg.exec('COMMIT');
    return result;
  } catch (error) {
    await db.pg.exec('ROLLBACK');
    throw error;
  }
}

const {
  recordShopVerdict,
  recordShopTakedownLabel,
  excludeDeletedShopListing,
  shopLabelSubject,
  SHOP_REVIEW_QUESTION,
  SHOP_TAKEDOWN_QUESTION,
} = await import('~/server/services/creator-shop-labels.service');

const LISTING = 42;
const COSMETIC = 7;
const CREATOR = 11;
const MOD = 99;
const OTHER_MOD = 98;
const at = (day: number) => `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`;

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await db.pg.query<T>(sql, params)).rows;

type LabelRow = {
  question: string;
  value: string;
  labellerKind: string;
  labellerRef: string;
  reasonNote: string | null;
  sourceRef: string;
  labelledAt: Date;
  subjectType: string;
  siteId: string;
  contentHash: string;
  snapshot: Record<string, unknown> | null;
  ownerHash: string | null;
  bytesRef: string | null;
  bytesExpireAt: string | null;
  excludedReason: string | null;
};
const labels = () =>
  rows<LabelRow>(
    `SELECT l.*, s."subjectType", s."subjectId" AS "siteId", s."contentHash", s."snapshot",
       s."ownerHash", s."bytesRef", s."bytesExpireAt"::text AS "bytesExpireAt", s."excludedReason"
     FROM label_store.label l JOIN label_store.subject s ON s.id = l."subjectId" ORDER BY l.id`
  );
const subjectCount = async () =>
  Number((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM label_store.subject`))[0].n);
const personHash = async (kind: 'owner' | 'labeller', id: number) =>
  (await rows<{ h: string }>(`SELECT label_store.person_hash($1, $2) AS h`, [kind, id]))[0].h;

type Listing = {
  title?: string;
  description?: string | null;
  unitAmount?: number;
  status?: string;
  history?: CosmeticShopItemHistoryEntry[];
  reviewedById?: number | null;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
  artworkKey?: string;
  imageHash?: string;
};
async function seed(listing: Listing = {}) {
  await db.pg.query(
    `INSERT INTO "Cosmetic" (id, type, data, "createdById", "pHashHex", "pHashUrl", "pHashVersion")
     VALUES ($1, 'ProfileDecoration', $2, $3, 'abcd', $4, 'perceptualDct256/256')`,
    [
      COSMETIC,
      JSON.stringify({ url: listing.artworkKey ?? 'art-2' }),
      CREATOR,
      listing.artworkKey ?? 'art-2',
    ]
  );
  await db.pg.query(
    `INSERT INTO "CosmeticShopItem" (id, "cosmeticId", title, description, "unitAmount", "addedById",
       status, meta, "reviewedById", "reviewedAt", "rejectionReason")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      LISTING,
      COSMETIC,
      listing.title ?? 'Hat',
      listing.description === undefined ? 'A hat' : listing.description,
      listing.unitAmount ?? 500,
      CREATOR,
      listing.status ?? 'PendingReview',
      JSON.stringify({
        purchases: 0,
        imageHash: listing.imageHash ?? 'bytes-of-art-2',
        history: listing.history ?? [
          { at: at(1), userId: CREATOR, kind: 'submitted', status: 'PendingReview' },
        ],
      }),
      listing.reviewedById ?? null,
      listing.reviewedAt ?? null,
      listing.rejectionReason ?? null,
    ]
  );
}

/** A verdict as the service writes it: the listing's update, then the label, in one transaction. */
async function review(action: 'approve' | 'reject' | 'request-changes' | 'revert', day: number) {
  const status =
    { approve: 'Published', reject: 'Rejected' }[action as string] ?? 'RequestedChanges';
  const entry = { at: at(day), userId: MOD, kind: 'reviewed', status, action, note: 'too dark' };
  return inTransaction(async (client) => {
    await db.pg.query(
      `UPDATE "CosmeticShopItem" SET status = $1,
         meta = jsonb_set(meta, '{history}', meta->'history' || $2::jsonb) WHERE id = $3`,
      [status, JSON.stringify([entry]), LISTING]
    );
    return recordShopVerdict(client, LISTING, {
      action,
      moderatorId: MOD,
      at: at(day),
      note: 'too dark',
      statusBefore: 'PendingReview',
      statusAfter: status,
    });
  });
}
const listingStatus = async () =>
  (
    await rows<{ status: string }>(`SELECT status FROM "CosmeticShopItem" WHERE id = $1`, [LISTING])
  )[0].status;

beforeAll(async () => {
  db.pg = await PGlite.create();
  await bootLabelStore(db.pg);
  await db.pg.exec(readFileSync(ATTACH_BYTES, 'utf8'));
  // Only the columns the label code reads, typed as the listing schema types them (enums as text).
  await db.pg.exec(`
    CREATE TABLE "Cosmetic" (
      id int PRIMARY KEY, type text NOT NULL, data jsonb, "createdById" int,
      "pHashHex" text, "pHashUrl" text, "pHashVersion" text
    );
    CREATE TABLE "ItemDefinition" (
      id int PRIMARY KEY, "sellerId" int, version int NOT NULL DEFAULT 1, "imageUrl" text
    );
    CREATE TABLE "CosmeticShopItem" (
      id int PRIMARY KEY, "cosmeticId" int, title text NOT NULL, description text,
      "unitAmount" int NOT NULL, "availableQuantity" int, meta jsonb NOT NULL DEFAULT '{}',
      "addedById" int, "itemDefinitionId" int, status text NOT NULL,
      "reviewedById" int, "reviewedAt" timestamp(3), "rejectionReason" text
    );
    CREATE TABLE "CosmeticShopItemCosmetic" (
      "shopItemId" int NOT NULL, "cosmeticId" int NOT NULL, index int NOT NULL DEFAULT 0
    );
    CREATE TABLE "BoxRevision" (id int PRIMARY KEY, "baseVersion" int NOT NULL, proposal jsonb NOT NULL);
  `);
  dbMock.dbWrite.$queryRaw.mockImplementation(tx.$queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(tx.$executeRaw as never);
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (client: typeof tx) => Promise<unknown>) =>
    inTransaction(fn)) as never);
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  statementTimeouts.length = 0;
  await db.pg.exec(`
    TRUNCATE label_store.subject, label_store.change, label_store.record_failure,
      label_store.erased_subject, label_store.erased_owner RESTART IDENTITY CASCADE;
    TRUNCATE "Cosmetic", "ItemDefinition", "CosmeticShopItem", "CosmeticShopItemCosmetic", "BoxRevision";
  `);
  // The store's functions are restored if a test renamed one away.
  await db.pg.exec(`
    DO $$ BEGIN
      IF to_regprocedure('label_store.record_label_away(text,text,text,text,text,text,text,text,timestamptz,integer,text,integer,text,text,integer,jsonb,bigint,integer)') IS NOT NULL THEN
        DROP FUNCTION IF EXISTS label_store.record_label(text,text,text,text,text,text,text,text,timestamptz,integer,text,integer,text,text,integer,jsonb,bigint,integer);
        ALTER FUNCTION label_store.record_label_away(text,text,text,text,text,text,text,text,timestamptz,integer,text,integer,text,text,integer,jsonb,bigint,integer) RENAME TO record_label;
      END IF;
    END $$;
  `);
});

describe('recordShopVerdict', () => {
  it('records the verdict on the listing as it was judged, owned by its creator and pointing at its artwork', async () => {
    await seed();

    expect(await review('request-changes', 2)).toBe(true);

    const [label] = await labels();
    expect(label).toMatchObject({
      question: SHOP_REVIEW_QUESTION,
      value: 'request_changes',
      labellerKind: 'moderator',
      labellerRef: await personHash('labeller', MOD),
      reasonNote: 'too dark',
      sourceRef: `CreatorShopReview:${LISTING}:${at(2)}:request_changes`,
      subjectType: 'shop_cosmetic',
      siteId: String(LISTING),
      ownerHash: await personHash('owner', CREATOR),
      bytesRef: 'cf-image:art-2',
    });
    expect(label.labelledAt.toISOString()).toBe(at(2));
    // No expiry: the site keeps the artwork, and training_examples shows a pointer before its expiry.
    expect(label.bytesExpireAt).toBe('infinity');
    expect(label.snapshot).toMatchObject({
      contentAt: 'verdict',
      title: 'Hat',
      description: 'A hat',
      unitAmount: 500,
      artworkKey: 'art-2',
      imageHash: 'bytes-of-art-2',
      pHashHex: 'abcd',
      statusBefore: 'PendingReview',
      statusAfter: 'RequestedChanges',
      queuedAt: at(1),
    });
    // PGlite cannot cancel a running statement (a pg_sleep past the timeout runs to the end), so the
    // timeout itself is only seen being set here.
    expect(statementTimeouts).toEqual(['3s']);
  });

  it('records the same verdict once', async () => {
    await seed();
    await review('reject', 2);
    expect(
      await inTransaction((client) =>
        recordShopVerdict(client, LISTING, {
          action: 'reject',
          moderatorId: MOD,
          at: at(2),
          statusAfter: 'Rejected',
        })
      )
    ).toBe(false);

    expect(await labels()).toHaveLength(1);
  });

  it('puts a takedown under its own question', async () => {
    await seed({ status: 'Published' });
    await inTransaction((client) =>
      recordShopVerdict(client, LISTING, {
        action: 'takedown',
        moderatorId: MOD,
        at: at(5),
        note: 'not theirs',
        statusBefore: 'Published',
        statusAfter: 'Archived',
      })
    );

    expect(await labels()).toEqual([
      expect.objectContaining({
        question: SHOP_TAKEDOWN_QUESTION,
        value: 'takedown',
        reasonNote: 'not theirs',
        sourceRef: `CreatorShopTakedown:${LISTING}:${at(5)}`,
      }),
    ]);
  });

  it('keeps the verdict when the store refuses the label', async () => {
    await seed();
    await db.pg.exec(
      `ALTER FUNCTION label_store.record_label(text,text,text,text,text,text,text,text,timestamptz,integer,text,integer,text,text,integer,jsonb,bigint,integer) RENAME TO record_label_away`
    );

    expect(await review('reject', 2)).toBe(false);

    expect(await listingStatus()).toBe('Rejected');
    expect(await labels()).toEqual([]);
  });

  it('keeps the verdict and its label apart from a failed bytes pointer', async () => {
    await seed();
    await db.pg.exec(`
      CREATE OR REPLACE FUNCTION label_store.attach_bytes(
        p_subject_type text, p_subject_id text, p_content_hash text, p_bytes_ref text,
        p_expire_at timestamptz DEFAULT NULL
      ) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage down'; END $$;
    `);
    try {
      expect(await review('approve', 2)).toBe(false);
      expect(await listingStatus()).toBe('Published');
      // The label and its pointer go together or not at all.
      expect(await labels()).toEqual([]);
    } finally {
      await db.pg.exec(readFileSync(ATTACH_BYTES, 'utf8'));
    }
  });
});

describe('recordShopTakedownLabel', () => {
  const takedown = {
    moderatorId: MOD,
    at: at(5),
    note: 'not theirs',
    statusBefore: 'Published' as const,
    statusAfter: 'Archived' as const,
  };
  const alerts = () =>
    loggingMock.logToAxiom.mock.calls.filter(
      ([entry]) => (entry as { name?: string }).name === 'shop-label-record-failed'
    );

  beforeEach(() => loggingMock.logToAxiom.mockClear());

  it('records the takedown in its own transaction', async () => {
    await seed({ status: 'Archived' });

    await recordShopTakedownLabel(LISTING, takedown);

    expect(await labels()).toEqual([
      expect.objectContaining({
        question: SHOP_TAKEDOWN_QUESTION,
        sourceRef: `CreatorShopTakedown:${LISTING}:${at(5)}`,
      }),
    ]);
    expect(alerts()).toEqual([]);
  });

  it('alerts, and does not throw, when the store refuses the label', async () => {
    await seed({ status: 'Archived' });
    await db.pg.exec(
      `ALTER FUNCTION label_store.record_label(text,text,text,text,text,text,text,text,timestamptz,integer,text,integer,text,text,integer,jsonb,bigint,integer) RENAME TO record_label_away`
    );

    await expect(recordShopTakedownLabel(LISTING, takedown)).resolves.toBeUndefined();

    expect(await labels()).toEqual([]);
    expect(alerts()).toEqual([
      [{ type: 'error', name: 'shop-label-record-failed', itemId: LISTING }],
    ]);
  });

  it('alerts, and does not throw, when its transaction cannot run', async () => {
    dbMock.dbWrite.$transaction.mockRejectedValueOnce(new Error('pool exhausted'));

    await expect(recordShopTakedownLabel(LISTING, takedown)).resolves.toBeUndefined();

    expect(alerts()).toEqual([
      [{ type: 'error', name: 'shop-label-record-failed', itemId: LISTING }],
    ]);
  });
});

describe('the subject a verdict is about', () => {
  const state = (over: Record<string, unknown> = {}) => ({
    listingId: LISTING,
    title: 'Hat',
    description: 'A hat',
    unitAmount: 500,
    availableQuantity: null,
    meta: null,
    addedById: CREATOR,
    cosmetic: {
      id: COSMETIC,
      type: 'ProfileDecoration',
      artworkKey: 'art-2',
      createdById: CREATOR,
      pHashHex: null,
    },
    members: [],
    box: null,
    revision: null,
    ...over,
  });
  const hash = (over: Record<string, unknown> = {}) => shopLabelSubject(state(over)).contentHash;

  it('is the art and text judged, not the price', () => {
    expect(hash({ unitAmount: 9000, availableQuantity: 3 })).toBe(hash());
    expect(hash({ title: 'Cap' })).not.toBe(hash());
    expect(hash({ description: null })).not.toBe(hash());
    expect(hash({ cosmetic: { ...state().cosmetic, artworkKey: 'art-3' } })).not.toBe(hash());
  });

  it("is a pack's cover and members, owned by its lister", () => {
    const members = [
      { cosmeticId: 1, artworkKey: 'a' },
      { cosmeticId: 2, artworkKey: 'b' },
    ];
    const pack = (over: Record<string, unknown> = {}) =>
      shopLabelSubject(state({ cosmetic: null, members, addedById: OTHER_MOD, ...over }));

    expect(pack()).toMatchObject({ subjectType: 'shop_pack', ownerId: OTHER_MOD, bytesRef: null });
    expect(pack({ unitAmount: 9000 }).contentHash).toBe(pack().contentHash);
    expect(
      pack({ members: [members[0], { cosmeticId: 2, artworkKey: 'c' }] }).contentHash
    ).not.toBe(pack().contentHash);
  });

  it('is the sha256 the store computes for the same canonical text', async () => {
    const content = JSON.stringify({
      artworkKey: 'art-2',
      description: 'A hat',
      title: 'Hat',
      type: 'ProfileDecoration',
      v: 1,
    });
    const [{ h }] = await rows<{ h: string }>(`SELECT label_store.text_hash($1) AS h`, [content]);
    expect(hash()).toBe(h);
    expect(h).toBe(createHash('sha256').update(content).digest('hex'));
  });
});

describe('a deleted listing', () => {
  it('keeps its judgements and drops its content', async () => {
    await seed();
    await review('reject', 2);

    await inTransaction((client) => excludeDeletedShopListing(client, LISTING));

    const [label] = await labels();
    expect(label).toMatchObject({ excludedReason: 'removed', snapshot: null, bytesRef: null });
  });
});
