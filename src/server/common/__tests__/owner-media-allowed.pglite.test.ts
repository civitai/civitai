import type { Prisma } from '@prisma/client';
import { Prisma as PrismaNs } from '@prisma/client';
import { CSAM_REPORT_LISTED_IMAGE_IDS_SQL } from '@civitai/shared/held-media';
import { ownerCsamMarkedSql } from '@civitai/shared/retracted-media-tier';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { BlockedReason } from '~/server/common/enums';
import { ownerMediaAllowed } from '~/server/common/image-block-marker';
import {
  ownerCsamMarkedColumnSql,
  ownerMediaAllowedSql,
  ownerMediaAllowedWhere,
  ownerMediaSql,
} from '~/server/common/image-visibility';

/**
 * Blocked images show their owner the block notice, not the media (civitai/civitai#10505), except
 * the metadata hold and, with `reviewedBlocks`, a moderated or tos block on an image with no CSAM
 * mark. `ownerMediaAllowed` and its database encodings answer every cell of one matrix alike: each
 * ingestion state against every block reason, comma lists, a reason no code writes ('zzz') and none,
 * plus single cells for each CSAM mark an image or its file can carry.
 */
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const INGESTIONS = ['Scanned', 'Pending', 'Error', 'Blocked', 'Rescan'] as const;
const REASONS = [
  null,
  BlockedReason.AiNotVerified,
  BlockedReason.TOS,
  BlockedReason.Moderated,
  BlockedReason.CSAM,
  'zzz',
  'moderated,tos',
  ' tos , moderated',
  'moderated,CSAM',
  'tos,csam',
  'moderated,zzz',
  'moderated,',
  '',
  'tos\n',
] as const;

type Mark = {
  label: string;
  blockedFor: string;
  /** Run after the row is inserted; `$id` and `$url` are the cell's. */
  setup?: string;
  needsReview?: string;
  pHash?: number;
};

// A moderated block plus one mark each. `marked` is the expected owner answer: withheld.
const MARKS: (Mark & { marked: boolean })[] = [
  {
    label: 'moderated + CSAM-blocked url sibling',
    blockedFor: 'moderated',
    setup: `INSERT INTO "Image" (id, "userId", url, ingestion, "blockedFor") VALUES ($id + 1000, 9, '$url', 'Blocked', 'CSAM')`,
    marked: true,
  },
  {
    label: 'moderated + CSAM-queued url sibling',
    blockedFor: 'moderated',
    setup: `INSERT INTO "Image" (id, "userId", url, ingestion, "needsReview") VALUES ($id + 1000, 9, '$url', 'Scanned', 'csam')`,
    marked: true,
  },
  {
    label: 'moderated + url sibling blocked tos,csam',
    blockedFor: 'moderated',
    setup: `INSERT INTO "Image" (id, "userId", url, ingestion, "blockedFor") VALUES ($id + 1000, 9, '$url', 'Blocked', 'tos,csam')`,
    marked: true,
  },
  {
    label: 'moderated + url siblings past the cap',
    blockedFor: 'moderated',
    setup: `INSERT INTO "Image" (id, "userId", url, ingestion)
      SELECT g, 9, '$url', 'Scanned' FROM generate_series(10000, 10049) g`,
    marked: true,
  },
  { label: 'moderated + csam review', blockedFor: 'moderated', needsReview: 'csam', marked: true },
  {
    label: 'moderated + CSAM hash block',
    blockedFor: 'moderated',
    pHash: 4242,
    setup: `INSERT INTO "BlockedImage" (hash, reason) VALUES (4242, 'CSAM')`,
    marked: true,
  },
  {
    label: 'moderated + CSAM vote',
    blockedFor: 'moderated',
    setup: `INSERT INTO "ScanLabelItem" (id, "imageId") VALUES ($id, $id);
      INSERT INTO "ScanLabelVote" ("itemId", reason) VALUES ($id, 'csam-realistic')`,
    marked: true,
  },
  {
    label: 'tos + CSAM vote',
    blockedFor: 'tos',
    setup: `INSERT INTO "ScanLabelItem" (id, "imageId") VALUES ($id, $id);
      INSERT INTO "ScanLabelVote" ("itemId", reason) VALUES ($id, 'csam-realistic')`,
    marked: true,
  },
  {
    label: 'moderated + a url copy deleted for CSAM review',
    blockedFor: 'moderated',
    setup: `INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview") VALUES ($id + 1000, '$url', 1, true)`,
    marked: true,
  },
  // By the Moderation Lead's ruling of 2026-11-27, a copy listed on a CSAM report withholds from
  // the owner whatever its report's state; only the owner's own row's listing does not.
  {
    label: 'moderated + a url copy deleted for CSAM review, listed on a sent, verified report',
    blockedFor: 'moderated',
    setup: `INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview") VALUES ($id + 1000, '$url', 1, true);
      INSERT INTO "CsamReport" ("userId", details, images, "reportSentAt") VALUES (1, '{"evidenceVerifiedAt": "2026-11-01T00:00:00Z"}', jsonb_build_array(jsonb_build_object('id', $id + 1000)), now())`,
    marked: true,
  },
  {
    label: 'moderated + another row on its url listed on a CSAM report',
    blockedFor: 'moderated',
    setup: `INSERT INTO "Image" (id, "userId", url, ingestion) VALUES ($id + 1000, 9, '$url', 'Scanned');
      INSERT INTO "CsamReport" (images) VALUES (jsonb_build_array($id + 1000))`,
    marked: true,
  },
  {
    label: 'moderated + another row on its url listed with a leading zero',
    blockedFor: 'moderated',
    setup: `INSERT INTO "Image" (id, "userId", url, ingestion) VALUES ($id + 1000, 9, '$url', 'Scanned');
      INSERT INTO "CsamReport" (images) VALUES (jsonb_build_array('0' || ($id + 1000)::text))`,
    marked: true,
  },
  {
    label: "moderated + the pHash of another user's listed image",
    blockedFor: 'moderated',
    pHash: 5151,
    setup: `INSERT INTO "Image" (id, "userId", url, ingestion, "pHash") VALUES ($id + 1000, 9, 'elsewhere-$id', 'Scanned', 5151);
      INSERT INTO "CsamReport" (images) VALUES (jsonb_build_array($id + 1000))`,
    marked: true,
  },
  {
    label: 'moderated + a url copy deleted, not for CSAM review',
    blockedFor: 'moderated',
    setup: `INSERT INTO "ImageCdnModeratorDelete" ("imageId", url, "userId", "csamReview") VALUES ($id + 1000, '$url', 1, false)`,
    marked: false,
  },
  {
    label: 'moderated + report-listed, no CSAM mark',
    blockedFor: 'moderated',
    // Its own pHash: its own listing must not count through the pHash check either.
    pHash: 8282,
    setup: `INSERT INTO "CsamReport" (images) VALUES ('[{"id": $id}]'::jsonb)`,
    marked: false,
  },
  {
    label: 'moderated + clean url sibling',
    blockedFor: 'moderated',
    setup: `INSERT INTO "Image" (id, "userId", url, ingestion) VALUES ($id + 1000, 9, '$url', 'Scanned')`,
    marked: false,
  },
  {
    label: 'moderated + a non-CSAM hash block',
    blockedFor: 'moderated',
    pHash: 777,
    setup: `INSERT INTO "BlockedImage" (hash, reason) VALUES (777, 'TOS')`,
    marked: false,
  },
];

type Cell = {
  id: number;
  url: string;
  ingestion: string;
  blockedFor: string | null;
  label?: string;
};

const MATRIX: Cell[] = INGESTIONS.flatMap((ingestion) =>
  REASONS.map((blockedFor) => ({ ingestion, blockedFor }))
).map((cell, i) => ({ id: i + 1, url: `u-${i + 1}`, ...cell }));
const MARK_CELLS: (Cell & Mark & { marked: boolean })[] = MARKS.map((mark, i) => ({
  ...mark,
  id: 500 + i,
  url: `m-${500 + i}`,
  ingestion: 'Blocked',
}));
const CELLS: Cell[] = [...MATRIX, ...MARK_CELLS];

const OWNER = 1;
const STRANGER = 2;

let h: Awaited<ReturnType<typeof startPglitePrisma>>;
/** Each cell's `ownerCsamMarkedSql`, the value a caller passes `ownerMediaAllowed`. */
let csamMarked: Map<number, boolean>;

beforeAll(async () => {
  h = await startPglitePrisma(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT ${OWNER}, url text,
      ingestion "ImageIngestionStatus" NOT NULL, "blockedFor" text, "needsReview" text, "pHash" bigint
    );
    CREATE TABLE "BlockedImage" (hash bigint, reason text);
    CREATE TABLE "ScanLabelItem" (id int PRIMARY KEY, "imageId" int, "voidReason" text);
    CREATE TABLE "ScanLabelFlag" ("itemId" int, snapshot jsonb);
    CREATE TABLE "ScanLabelVote" ("itemId" int, reason text);
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]', "reportSentAt" timestamp);
    CREATE TABLE "ImageCdnModeratorDelete" ("imageId" int, url text, "userId" int, "csamReview" boolean);
  `);
  for (const { id, url, ingestion, blockedFor } of MATRIX)
    await h.prisma.$executeRaw`INSERT INTO "Image" (id, url, ingestion, "blockedFor")
      VALUES (${id}, ${url}, ${ingestion}::"ImageIngestionStatus", ${blockedFor})`;
  for (const cell of MARK_CELLS) {
    await h.prisma
      .$executeRaw`INSERT INTO "Image" (id, url, ingestion, "blockedFor", "needsReview", "pHash")
      VALUES (${cell.id}, ${cell.url}, 'Blocked', ${cell.blockedFor}, ${
      cell.needsReview ?? null
    }, ${cell.pHash ?? null})`;
    if (cell.setup)
      for (const statement of cell.setup.split(';'))
        await h.prisma.$executeRawUnsafe(
          statement.replaceAll('$id', String(cell.id)).replaceAll('$url', cell.url)
        );
  }
  const marks = await h.prisma.$queryRawUnsafe<{ id: number; marked: boolean }[]>(
    `SELECT i.id, ${ownerCsamMarkedSql('i')} AS marked FROM "Image" i WHERE i."userId" = ${OWNER}`
  );
  csamMarked = new Map(marks.map((r) => [r.id, r.marked]));
});
afterAll(() => h?.stop());

const sqlAllowed = async (where: Prisma.Sql) =>
  (
    await h.prisma.$queryRaw<
      { id: number }[]
    >`SELECT i.id FROM "Image" i WHERE i."userId" = ${OWNER} AND ${where} ORDER BY i.id`
  ).map((r) => r.id);

const withMark = (cell: Cell) => ({ ...cell, ownerCsamMarked: csamMarked.get(cell.id) });
const tsAllowed = (reviewedBlocks: boolean) =>
  CELLS.filter((cell) => ownerMediaAllowed(withMark(cell), { reviewedBlocks })).map((c) => c.id);
const named = (ids: number[]) =>
  ids.map((id) => {
    const cell = CELLS.find((c) => c.id === id)!;
    return cell.label ?? `${cell.ingestion}/${cell.blockedFor}`;
  });

const TODAY = [
  'Scanned/null',
  'Scanned/AiNotVerified',
  'Pending/null',
  'Pending/AiNotVerified',
  'Error/null',
  'Error/AiNotVerified',
  'Blocked/AiNotVerified',
  'Rescan/null',
  'Rescan/AiNotVerified',
];

describe('ownerMediaAllowed, reviewedBlocks off (the flag off)', () => {
  it('leaves the owner the media only with no block, or the metadata hold alone', () => {
    expect(named(tsAllowed(false))).toEqual(TODAY);
  });

  it('ignores ownerCsamMarked: false, so a moderated block stays withheld', () => {
    expect(
      ownerMediaAllowed({ ingestion: 'Blocked', blockedFor: 'moderated', ownerCsamMarked: false })
    ).toBe(false);
  });

  it('agrees with its SQL twin on every cell, an unknown reason included', async () => {
    expect(await sqlAllowed(ownerMediaAllowedSql())).toEqual(tsAllowed(false));
  });

  it('agrees with its Prisma filter on every cell', async () => {
    const rows = await h.prisma.image.findMany({
      where: { AND: [{ userId: OWNER }, ownerMediaAllowedWhere()] },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual(tsAllowed(false));
  });
});

describe('ownerMediaAllowed, reviewedBlocks on', () => {
  it('adds a moderated or tos block, alone or listed together, with no CSAM mark', () => {
    const added = named(tsAllowed(true).filter((id) => !tsAllowed(false).includes(id)));
    // Only an image whose scan ended Blocked: an unfinished scan may not have read its marks yet.
    expect(added).toEqual([
      ...['tos', 'moderated', 'moderated,tos', ' tos , moderated'].map((r) => `Blocked/${r}`),
      'moderated + a url copy deleted, not for CSAM review',
      'moderated + report-listed, no CSAM mark',
      'moderated + clean url sibling',
      'moderated + a non-CSAM hash block',
    ]);
  });

  it('withholds every CSAM mark, csam in the list, an unknown reason and a malformed list', () => {
    const allowed = new Set(named(tsAllowed(true)));
    for (const cell of MARK_CELLS) expect(allowed.has(cell.label!)).toBe(!cell.marked);
    for (const reason of [
      'tos\n',
      'CSAM',
      'zzz',
      'moderated,CSAM',
      'tos,csam',
      'moderated,zzz',
      'moderated,',
      '',
    ])
      for (const ingestion of INGESTIONS) expect(allowed.has(`${ingestion}/${reason}`)).toBe(false);
  });

  it('withholds a moderated block whose CSAM check was not read', () => {
    expect(
      ownerMediaAllowed({ ingestion: 'Blocked', blockedFor: 'moderated' }, { reviewedBlocks: true })
    ).toBe(false);
    expect(
      ownerMediaAllowed(
        { ingestion: 'Blocked', blockedFor: 'moderated', ownerCsamMarked: null },
        { reviewedBlocks: true }
      )
    ).toBe(false);
  });

  it('agrees with its SQL twin on every cell', async () => {
    expect(await sqlAllowed(ownerMediaAllowedSql('i', { reviewedBlocks: true }))).toEqual(
      tsAllowed(true)
    );
  });

  it('keeps the Prisma filter to the stricter flag-off answer, never wider', async () => {
    const prismaIds = (
      await h.prisma.image.findMany({
        where: { AND: [{ userId: OWNER }, ownerMediaAllowedWhere()] },
        select: { id: true },
      })
    ).map((r) => r.id);
    const wide = new Set(tsAllowed(true));
    expect(prismaIds.every((id) => wide.has(id))).toBe(true);
  });

  it('reads the report listing as no CSAM mark (the cell really is listed)', async () => {
    const cell = MARK_CELLS.find((c) => c.label === 'moderated + report-listed, no CSAM mark')!;
    const [{ listed }] = await h.prisma.$queryRaw<{ listed: boolean }[]>`
      SELECT ${cell.id}::text IN (${PrismaNs.raw(CSAM_REPORT_LISTED_IMAGE_IDS_SQL)}) AS listed`;
    expect(listed).toBe(true);
    expect(csamMarked.get(cell.id)).toBe(false);
  });
});

describe('ownerMediaSql', () => {
  it('holds the owner to the rule and leaves everyone else to the caller', async () => {
    const all = (
      await h.prisma.$queryRaw<
        { id: number }[]
      >`SELECT id FROM "Image" WHERE "userId" = ${OWNER} ORDER BY id`
    ).map((r) => r.id);
    expect(await sqlAllowed(ownerMediaSql(OWNER))).toEqual(tsAllowed(false));
    expect(await sqlAllowed(ownerMediaSql(STRANGER))).toEqual(all);
    expect(await sqlAllowed(ownerMediaSql(undefined))).toEqual(all);
  });
});

describe('ownerCsamMarkedSql', () => {
  it('refuses an alias its own subqueries use', () => {
    expect(() => ownerCsamMarkedSql('os')).toThrow();
    expect(() => ownerCsamMarkedSql('i; DROP')).toThrow();
  });
});

describe('ownerCsamMarkedColumnSql', () => {
  it("reads the mark only for the viewer's own blocked image, NULL for every other row", async () => {
    const read = (viewerId: number, id: number) =>
      h.prisma.$queryRaw<{ marked: boolean | null }[]>`
        SELECT ${ownerCsamMarkedColumnSql(
          viewerId
        )} AS marked, i.id FROM "Image" i WHERE i.id = ${id}`;
    const clean = MARK_CELLS.find((c) => !c.marked)!;
    const csam = MARK_CELLS.find((c) => c.marked)!;
    const unblocked = MATRIX.find((c) => c.blockedFor === null)!;
    expect(await read(OWNER, clean.id)).toEqual([{ marked: false, id: clean.id }]);
    expect(await read(OWNER, csam.id)).toEqual([{ marked: true, id: csam.id }]);
    expect(await read(STRANGER, csam.id)).toEqual([{ marked: null, id: csam.id }]);
    expect(await read(OWNER, unblocked.id)).toEqual([{ marked: null, id: unblocked.id }]);
  });
});

describe("an unblocked image with the pHash of another user's listed image", () => {
  it('is still served to its owner: the report checks apply only under a reviewed block', async () => {
    await h.prisma.$executeRawUnsafe(`
      INSERT INTO "Image" (id, url, ingestion, "pHash") VALUES (9100, 'u-9100', 'Scanned', 6161)`);
    await h.prisma.$executeRawUnsafe(`
      INSERT INTO "Image" (id, "userId", url, ingestion, "pHash") VALUES (9101, 9, 'u-9101', 'Scanned', 6161)`);
    await h.prisma.$executeRawUnsafe(`INSERT INTO "CsamReport" (images) VALUES ('[9101]'::jsonb)`);
    const [{ marked }] = await h.prisma.$queryRawUnsafe<{ marked: boolean }[]>(
      `SELECT ${ownerCsamMarkedSql('i')} AS marked FROM "Image" i WHERE i.id = 9100`
    );
    expect(marked).toBe(true);
    const ids = await sqlAllowed(ownerMediaAllowedSql('i', { reviewedBlocks: true }));
    expect(ids).toContain(9100);
    expect(
      ownerMediaAllowed({ ingestion: 'Scanned', blockedFor: null }, { reviewedBlocks: true })
    ).toBe(true);
  });
});
