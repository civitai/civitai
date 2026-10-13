import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Audit from '~/utils/metadata/audit';
import type * as Blocklist from '~/server/services/blocklist.service';
import type * as ImageService from '~/server/services/image.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/utils/metadata/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof Audit>()),
  auditMetaData: vi.fn(() => ({ success: true })),
  includesInappropriate: vi.fn(() => false),
  includesPoi: vi.fn(() => false),
}));
vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Blocklist>()),
  stripBenignPhrases: vi.fn(async (text: string) => text),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImagesModRules: vi.fn(async () => []),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { resolveScanOutcome, type ScanImage } from '../image-scan-pipeline';
import { auditMetaData, includesInappropriate } from '~/utils/metadata/audit';
import { createNotification } from '~/server/services/notification.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite, newUser: false }));
const IMAGE = 51;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "updatedAt" timestamp(3),
      "pHash" bigint,
      ingestion "ImageIngestionStatus",
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      "needsReview" text,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      "scannedAt" timestamp(3),
      metadata jsonb,
      "scanJobs" jsonb
    );
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post', 'Model');
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected');
    CREATE TABLE "Appeal" (
      id serial PRIMARY KEY,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      status "AppealStatus" NOT NULL DEFAULT 'Pending'
    );
  `);
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(includesInappropriate).mockReturnValue(false);
  vi.mocked(auditMetaData).mockReturnValue({ success: true } as never);
  holder.newUser = false;
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    const { affectedRows } = await holder.db.query(flat.text, flat.values as unknown[]);
    return affectedRows ?? 0;
  }) as never);
  dbMock.dbWrite.appeal.findMany.mockImplementation(
    (async ({ where }: any) =>
      (
        await holder.db.query(
          `SELECT "entityId" FROM "Appeal" WHERE "entityId" = ANY($1) AND "entityType" = 'Image' AND status = 'Pending'`,
          [where.entityId.in]
        )
      ).rows) as never
  );
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (strings: TemplateStringsArray) => {
    const text = strings.join('');
    if (text.includes('TagsOnImageDetails'))
      return [{ id: 10, name: 'tag', type: 'Label', nsfwLevel: 16, confidence: 90 }];
    if (text.includes('is_new_user')) return [{ isNewUser: holder.newUser }];
    return [{ poi: false, minor: false, hasResource: false }];
  }) as never);
  await holder.db.exec(`
    TRUNCATE "Image", "Appeal";
    INSERT INTO "Image" (id, ingestion, "nsfwLevel") VALUES (${IMAGE}, 'Pending', 0);
  `);
});

type Row = {
  ingestion: string;
  blockedFor: string | null;
  nsfwLevel: number;
  needsReview: string | null;
};

const imageRow = async () =>
  (
    await holder.db.query<Row>(
      `SELECT ingestion, "blockedFor", "nsfwLevel", "needsReview" FROM "Image" WHERE id = $1`,
      [IMAGE]
    )
  ).rows[0];

const scan = async (scanFlagged: boolean, over: Partial<ScanImage> = {}) => {
  const row = await imageRow();
  return resolveScanOutcome({
    image: {
      id: IMAGE,
      userId: 2,
      createdAt: new Date('2025-12-01T00:00:00.000Z'),
      scannedAt: null,
      type: 'image',
      meta: { prompt: 'a prompt' },
      metadata: {},
      postId: null,
      nsfwLevelLocked: false,
      ...row,
      ...over,
    } as unknown as ScanImage,
    scanFlagged,
    workflowId: 'wf',
    prompt: 'a prompt',
  });
};

describe('an upload the orchestrator refused', () => {
  it('is held for minor review, not blocked, and nobody is notified', async () => {
    const outcome = await scan(true);

    expect(outcome).toMatchObject({ ingestion: 'Scanned', blockedFor: null, reviewKey: 'minor' });
    expect(await imageRow()).toEqual({
      ingestion: 'Scanned',
      blockedFor: null,
      nsfwLevel: 16,
      needsReview: 'minor',
    });
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('outranks a new-user review', async () => {
    holder.newUser = true;

    await scan(true);

    expect((await imageRow()).needsReview).toBe('minor');
  });

  it('leaves a real-person review in its own queue', async () => {
    vi.mocked(includesInappropriate).mockReturnValue('poi' as never);

    await scan(true);

    expect((await imageRow()).needsReview).toBe('poi');
  });

  it('leaves an image the prompt audit blocked blocked', async () => {
    vi.mocked(auditMetaData).mockReturnValue({ success: false, blockedFor: ['prompt'] } as never);

    await scan(true);

    expect(await imageRow()).toMatchObject({ ingestion: 'Blocked', needsReview: null });
  });

  it('stays in the CSAM review it is already in', async () => {
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${IMAGE}`);

    await scan(true);

    expect((await imageRow()).needsReview).toBe('csam');
  });

  it('stays in the appeals queue when its owner already appealed', async () => {
    await holder.db.exec(`
      UPDATE "Image" SET ingestion = 'Rescan', "needsReview" = 'appeal' WHERE id = ${IMAGE};
      INSERT INTO "Appeal" ("entityType", "entityId") VALUES ('Image', ${IMAGE});
    `);

    await scan(true);

    expect((await imageRow()).needsReview).toBe('appeal');
  });
});

describe('an upload the orchestrator passed', () => {
  it('is scanned with no review', async () => {
    const outcome = await scan(false);

    expect(outcome.ingestion).toBe('Scanned');
    expect(await imageRow()).toEqual({
      ingestion: 'Scanned',
      blockedFor: null,
      nsfwLevel: 16,
      needsReview: null,
    });
  });

  it('still goes to minor review when the existing checks send it there', async () => {
    vi.mocked(includesInappropriate).mockReturnValue('minor' as never);

    await scan(false);

    expect(await imageRow()).toMatchObject({ ingestion: 'Scanned', needsReview: 'minor' });
  });

  it('still goes to new-user review', async () => {
    holder.newUser = true;

    await scan(false);

    expect((await imageRow()).needsReview).toBe('newUser');
  });
});
