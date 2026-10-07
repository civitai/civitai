import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { createCsamReport } from '~/server/services/csam.service';

type Row = {
  id: number;
  userId: number | null;
  reportedById: number;
  reportSentAt: Date | null;
  createdAt: Date;
  details: unknown;
  images: unknown;
  type: string;
};

const INTERNAL = -1;
const MOD = 9;
const OLD = new Date('2026-01-01T00:00:00Z');

let rows: Row[];
let nextId: number;

// Prisma drops a `where` key whose value is `undefined` rather than matching it, and that is the
// semantics a lookup with a missing user id is judged by — so the fake applies the same rule.
function matches(row: Row, where: Record<string, unknown>) {
  return Object.entries(where).every(
    ([key, value]) => value === undefined || row[key as keyof Row] === value
  );
}

function seed(partial: Partial<Row> & Pick<Row, 'userId'>) {
  const row: Row = {
    id: nextId++,
    reportedById: MOD,
    reportSentAt: null,
    createdAt: OLD,
    details: {},
    images: [],
    type: 'Image',
    ...partial,
  };
  rows.push(row);
  return structuredClone(row);
}

beforeEach(() => {
  rows = [];
  nextId = 1;
  const table = dbMock.dbWrite.csamReport;
  table.findFirst.mockClear();
  table.update.mockClear();
  table.create.mockClear();
  table.findFirst.mockImplementation(
    async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((row) => matches(row, where)) ?? null
  );
  table.update.mockImplementation(
    async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) throw new Error(`no row ${where.id}`);
      Object.assign(row, data);
      return row;
    }
  );
  table.create.mockImplementation(async ({ data }: { data: Partial<Row> & Pick<Row, 'userId'> }) =>
    seed({ ...data, createdAt: new Date() })
  );
});

describe('unsent-report lookup', () => {
  it('fake honours Prisma dropping an undefined where key, so the revert case is reachable', async () => {
    seed({ userId: 101 });
    await expect(
      dbMock.dbWrite.csamReport.findFirst({ where: { userId: undefined, reportSentAt: null } })
    ).resolves.toMatchObject({ userId: 101 });
  });

  it('a report with no account leaves two other accounts’ unsent reports untouched', async () => {
    const a = seed({ userId: 101, details: { note: 'account A' }, images: [{ id: 1 }] });
    const b = seed({ userId: 202, details: { note: 'account B' }, images: [{ id: 2 }] });

    await createCsamReport({
      userId: INTERNAL,
      reportedById: MOD,
      type: 'Image',
      imageIds: [3],
    });

    expect(rows.find((r) => r.id === a.id)).toEqual(a);
    expect(rows.find((r) => r.id === b.id)).toEqual(b);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ userId: null, images: [{ id: 3 }] });
    expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
  });

  // Deliberate: reports with no account are never merged, even with each other. Each is a separate
  // incident, and an update replaces the earlier one's images. Do not "dedupe" these on userId null.
  it('two reports with no account stay two reports', async () => {
    for (const id of [1, 2]) {
      await createCsamReport({
        userId: INTERNAL,
        reportedById: MOD,
        type: 'Image',
        imageIds: [id],
      });
    }

    expect(rows.map((r) => r.images)).toEqual([[{ id: 1 }], [{ id: 2 }]]);
  });

  it('an account’s report updates that account’s unsent report, not a sent one or another account’s', async () => {
    const sent = seed({ userId: 101, reportSentAt: OLD, images: [{ id: 1 }] });
    const other = seed({ userId: 202, images: [{ id: 2 }] });
    const unsent = seed({ userId: 101, images: [{ id: 3 }] });

    await createCsamReport({ userId: 101, reportedById: MOD, type: 'Image', imageIds: [4] });

    expect(rows.find((r) => r.id === sent.id)).toEqual(sent);
    expect(rows.find((r) => r.id === other.id)).toEqual(other);
    expect(rows.find((r) => r.id === unsent.id)).toMatchObject({ images: [{ id: 4 }] });
    expect(rows).toHaveLength(3);
  });

  it('an account’s report of one type leaves its unsent report of another type untouched', async () => {
    const external = seed({ userId: 101, type: 'ExternalLink', details: { url: 'x' } });

    await createCsamReport({ userId: 101, reportedById: MOD, type: 'Image', imageIds: [4] });

    expect(rows.find((r) => r.id === external.id)).toEqual(external);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ userId: 101, type: 'Image', images: [{ id: 4 }] });
  });
});
