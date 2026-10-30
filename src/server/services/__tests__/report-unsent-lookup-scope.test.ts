import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { createCsamReport } from '~/server/services/csam.service';
import { CSAM_SEND_CLAIM_EXPIRY_SECONDS } from '~/server/services/csam.service-new';
import { CSAM_SEND_JOB_LOCK_SECONDS } from '~/server/jobs/process-csam';
import { logToAxiom } from '~/server/logging/client';

type Row = {
  id: number;
  userId: number | null;
  reportedById: number;
  reportSentAt: Date | null;
  createdAt: Date;
  details: unknown;
  images: unknown;
  type: string;
  sendClaimId: string | null;
  sendClaimedAt: Date | null;
};

const INTERNAL = -1;
const MOD = 9;
const OLD = new Date('2026-01-01T00:00:00Z');

let rows: Row[];
let nextId: number;

type JsonPathFilter = { path: string[]; equals: unknown };
const isJsonPathFilter = (value: unknown): value is JsonPathFilter =>
  typeof value === 'object' && value !== null && 'path' in value && 'equals' in value;

// Prisma drops a `where` key whose value is `undefined` rather than matching it, and that is the
// semantics a lookup with a missing user id is judged by — so the fake applies the same rule.
function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) return true;
    if (key === 'OR')
      return (value as Record<string, unknown>[]).some((branch) => matches(row, branch));
    if (value instanceof Object && 'lt' in value) {
      const stored = row[key as keyof Row];
      return stored instanceof Date && stored < (value.lt as Date);
    }
    // As Prisma does, an undefined `equals` constrains nothing.
    if (isJsonPathFilter(value) && value.equals === undefined) return true;
    if (isJsonPathFilter(value)) {
      const list = value.path.reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | null)?.[part],
        row[key as keyof Row]
      );
      return JSON.stringify(list) === JSON.stringify(value.equals);
    }
    return row[key as keyof Row] === value;
  });
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
    sendClaimId: null,
    sendClaimedAt: null,
    ...partial,
  };
  rows.push(row);
  return structuredClone(row);
}

const create = async ({ data }: { data: Partial<Row> & Pick<Row, 'userId'> }) =>
  seed({ ...data, createdAt: new Date() });

// The transaction's own client: the lookup, the lock and the update must run on it, not on dbWrite.
const tx = {
  csamReport: {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const row = rows.find((r) => matches(r, where));
      return row ? { id: row.id } : null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    }),
    create: vi.fn(create),
  },
  // The row lock: the report by id, while it is still unsent.
  $queryRaw: vi.fn(async (_: TemplateStringsArray, id: number) =>
    rows
      .filter((row) => row.id === id && row.reportSentAt === null)
      .map(({ images, details, sendClaimId, sendClaimedAt }) =>
        structuredClone({ images, details, sendClaimId, sendClaimedAt })
      )
  ),
};

const lockSql = () => (tx.$queryRaw.mock.calls[0][0] as readonly string[]).join('?');

beforeEach(() => {
  rows = [];
  nextId = 1;
  for (const fn of [
    tx.csamReport.findFirst,
    tx.csamReport.update,
    tx.csamReport.create,
    tx.$queryRaw,
  ])
    fn.mockClear();
  const outside = () => {
    throw new Error('ran outside the transaction');
  };
  dbMock.dbWrite.csamReport.findFirst.mockReset().mockImplementation(outside as never);
  dbMock.dbWrite.csamReport.update.mockReset().mockImplementation(outside as never);
  dbMock.dbWrite.$queryRaw.mockReset().mockImplementation(outside as never);
  dbMock.dbWrite.csamReport.create.mockReset().mockImplementation(create as never);
  dbMock.dbWrite.$transaction
    .mockReset()
    .mockImplementation((async (fn: (client: typeof tx) => unknown) => fn(tx)) as never);
});

describe('unsent-report lookup', () => {
  it('fake honours Prisma dropping an undefined where key, so the revert case is reachable', async () => {
    seed({ userId: 101 });
    await expect(
      tx.csamReport.findFirst({ where: { userId: undefined, reportSentAt: null } })
    ).resolves.toEqual({ id: 1 });
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
    expect(tx.csamReport.update).not.toHaveBeenCalled();
  });

  // Deliberate: reports with no account are never merged, even with each other. Each is a separate
  // incident. Do not "dedupe" these on userId null.
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
    expect(rows.find((r) => r.id === unsent.id)).toMatchObject({ images: [{ id: 3 }, { id: 4 }] });
    expect(rows).toHaveLength(3);
  });

  it('an account’s report is filed on its own beside an unsent supplemental report', async () => {
    const supplemental = seed({
      userId: 101,
      images: [{ id: 3 }],
      details: {
        supplemental: { priorCsamReportId: 1, priorReportNumbers: [900], unreviewedImageIds: [] },
      },
    });

    await createCsamReport({ userId: 101, reportedById: MOD, type: 'Image', imageIds: [4] });

    expect(rows.find((r) => r.id === supplemental.id)).toEqual(supplemental);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ userId: 101, images: [{ id: 4 }] });
  });

  it('locks the report it found, only while it is unsent', async () => {
    const unsent = seed({ userId: 101, images: [{ id: 3 }] });

    await createCsamReport({ userId: 101, reportedById: MOD, type: 'Image', imageIds: [4] });

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(unsent.id);
    expect(lockSql()).toMatch(
      /^\s*SELECT images, details, "sendClaimId", "sendClaimedAt" FROM "CsamReport"\s+WHERE id = \? AND "reportSentAt" IS NULL\s+FOR UPDATE\s*$/
    );
  });

  it('a report sent after the lookup is left alone, and the new report filed on its own', async () => {
    const raced = seed({ userId: 101, images: [{ id: 1 }] });
    // The lookup still sees the report unsent; it is sent before the lock.
    tx.csamReport.findFirst.mockImplementationOnce(async () => {
      const row = rows.find((r) => r.id === raced.id)!;
      row.reportSentAt = OLD;
      return { id: row.id };
    });

    await createCsamReport({ userId: 101, reportedById: MOD, type: 'Image', imageIds: [4] });

    expect(rows.find((r) => r.id === raced.id)).toMatchObject({ images: [{ id: 1 }] });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ userId: 101, images: [{ id: 4 }] });
    expect(tx.csamReport.update).not.toHaveBeenCalled();
    expect(tx.csamReport.create).toHaveBeenCalledTimes(1);
  });

  it('an account’s report of one type leaves its unsent report of another type untouched', async () => {
    const external = seed({ userId: 101, type: 'ExternalLink', details: { url: 'x' } });

    await createCsamReport({ userId: 101, reportedById: MOD, type: 'Image', imageIds: [4] });

    expect(rows.find((r) => r.id === external.id)).toEqual(external);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ userId: 101, type: 'Image', images: [{ id: 4 }] });
  });
});

describe('a second report folded into an unsent one', () => {
  it('keeps the first report’s images, the data recorded on them, and its details', async () => {
    const first = seed({
      userId: 101,
      images: [{ id: 1 }, { id: 2, fileId: 'file-2', hash: 'hash-2' }],
      details: {
        modelVersionIds: [7],
        minorDepiction: 'non-real',
        capabilities: ['create'],
        contents: ['nonRealMinors'],
        readFailures: { 2: 1 },
      },
    });

    await createCsamReport({
      userId: 101,
      reportedById: MOD,
      type: 'Image',
      imageIds: [2, 3],
      details: {
        modelVersionIds: [8],
        minorDepiction: 'real',
        capabilities: ['edit'],
        contents: ['variations'],
      },
    });

    expect(rows).toHaveLength(1);
    const folded = rows.find((r) => r.id === first.id)!;
    expect(folded.images).toEqual([
      { id: 1 },
      { id: 2, fileId: 'file-2', hash: 'hash-2' },
      { id: 3 },
    ]);
    expect(folded.details).toEqual({
      modelVersionIds: [7, 8],
      minorDepiction: 'real',
      capabilities: ['create', 'edit'],
      contents: ['nonRealMinors', 'variations'],
      readFailures: { 2: 1 },
    });
  });

  it('keeps the stored details when the second filing sends none, or leaves an answer unset', async () => {
    const first = seed({
      userId: 101,
      images: [{ id: 1, fileId: 'file-1' }],
      details: { modelVersionIds: [7], minorDepiction: 'non-real' },
    });

    await createCsamReport({ userId: 101, reportedById: MOD, type: 'Image', imageIds: [2] });
    await createCsamReport({
      userId: 101,
      reportedById: MOD,
      type: 'Image',
      imageIds: [3],
      details: { minorDepiction: undefined },
    });

    const folded = rows.find((r) => r.id === first.id)!;
    expect(folded.images).toEqual([{ id: 1, fileId: 'file-1' }, { id: 2 }, { id: 3 }]);
    expect(folded.details).toEqual({ modelVersionIds: [7], minorDepiction: 'non-real' });
  });

  it('never downgrades a real-minor depiction', async () => {
    const first = seed({ userId: 101, details: { minorDepiction: 'real' } });

    await createCsamReport({
      userId: 101,
      reportedById: MOD,
      type: 'Image',
      imageIds: [2],
      details: { minorDepiction: 'non-real' },
    });

    expect(rows.find((r) => r.id === first.id)?.details).toEqual({ minorDepiction: 'real' });
  });

  it('folds into a report whose stored details are JSON null', async () => {
    const first = seed({ userId: 101, images: [{ id: 1 }], details: null });

    await createCsamReport({
      userId: 101,
      reportedById: MOD,
      type: 'Image',
      imageIds: [2],
      details: { modelVersionIds: [8] },
    });

    const folded = rows.find((r) => r.id === first.id)!;
    expect(folded.images).toEqual([{ id: 1 }, { id: 2 }]);
    expect(folded.details).toEqual({ modelVersionIds: [8] });
  });

  it('keeps the first report’s generated images, and the blobs of a job both name', async () => {
    const first = seed({
      userId: 101,
      type: 'GeneratedImage',
      details: {
        generatedImages: [
          { jobId: 'job-a', blobs: [{ url: 'a1' }] },
          { jobId: 'job-c', blobs: [{ url: 'c' }] },
        ],
      },
    });

    await createCsamReport({
      userId: 101,
      reportedById: MOD,
      type: 'GeneratedImage',
      details: {
        generatedImages: [
          { jobId: 'job-a', blobs: [{ url: 'a1' }, { url: 'a2' }] },
          { jobId: 'job-b', blobs: [{ url: 'b' }] },
        ],
      },
    });

    expect(rows.find((r) => r.id === first.id)?.details).toEqual({
      generatedImages: [
        { jobId: 'job-a', blobs: [{ url: 'a1' }, { url: 'a2' }] },
        { jobId: 'job-c', blobs: [{ url: 'c' }] },
        { jobId: 'job-b', blobs: [{ url: 'b' }] },
      ],
    });
  });

  it('files training data for another version as its own report, and folds the same version', async () => {
    const v1 = seed({ userId: 101, type: 'TrainingData', details: { modelVersionIds: [7] } });

    await createCsamReport({
      userId: 101,
      reportedById: MOD,
      type: 'TrainingData',
      details: { modelVersionIds: [8] },
    });
    await createCsamReport({
      userId: 101,
      reportedById: MOD,
      type: 'TrainingData',
      details: { modelVersionIds: [7], minorDepiction: 'real' },
    });

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === v1.id)?.details).toEqual({
      modelVersionIds: [7],
      minorDepiction: 'real',
    });
    expect(rows[1]).toMatchObject({ type: 'TrainingData', details: { modelVersionIds: [8] } });
    expect(tx.csamReport.create).toHaveBeenCalledTimes(1);
  });

  it('files training data naming no version, or only some of a report’s versions, as its own report', async () => {
    const both = seed({ userId: 101, type: 'TrainingData', details: { modelVersionIds: [7, 8] } });

    await createCsamReport({ userId: 101, reportedById: MOD, type: 'TrainingData' });
    await createCsamReport({
      userId: 101,
      reportedById: MOD,
      type: 'TrainingData',
      details: { modelVersionIds: [8] },
    });

    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === both.id)?.details).toEqual({ modelVersionIds: [7, 8] });
  });

  it('folds training data naming no version into a report that names none', async () => {
    const none = seed({ userId: 101, type: 'TrainingData', details: { modelVersionIds: [] } });

    await createCsamReport({
      userId: 101,
      reportedById: MOD,
      type: 'TrainingData',
      details: { minorDepiction: 'real' },
    });

    expect(rows).toHaveLength(1);
    expect(rows.find((r) => r.id === none.id)?.details).toEqual({
      modelVersionIds: [],
      minorDepiction: 'real',
    });
  });

  it('keeps stored generated-images entries it cannot merge, and does not fail on them', async () => {
    const first = seed({
      userId: 101,
      type: 'GeneratedImage',
      details: {
        generatedImages: [
          { jobId: 'job-a', blobs: [{ url: 'a' }] },
          { jobId: 'job-a', blobs: 'corrupt' },
          { blobs: [{ url: 'x' }] },
          { blobs: [{ url: 'y' }] },
        ],
      },
    });

    await createCsamReport({
      userId: 101,
      reportedById: MOD,
      type: 'GeneratedImage',
      details: { generatedImages: [{ jobId: 'job-a', blobs: [{ url: 'a' }] }] },
    });

    expect(rows.find((r) => r.id === first.id)?.details).toEqual({
      generatedImages: [
        { jobId: 'job-a', blobs: [{ url: 'a' }] },
        { blobs: [{ url: 'x' }] },
        { blobs: [{ url: 'y' }] },
      ],
    });
  });
});

describe('a report a send run has claimed', () => {
  const claimedAgo = (seconds: number) => ({
    sendClaimId: 'run-1',
    sendClaimedAt: new Date(Date.now() - seconds * 1000),
  });
  const skipLines = () =>
    vi
      .mocked(logToAxiom)
      .mock.calls.map(([payload]) => payload as Record<string, unknown>)
      .filter((line) => line.subType === 'fold-skip-claimed');
  beforeEach(() => vi.mocked(logToAxiom).mockClear());

  it.each([
    ['just claimed', 60],
    ['claimed as long as the job lock', CSAM_SEND_JOB_LOCK_SECONDS + 60],
  ])(
    'takes no filing while the run holds it (%s): the filing is a report of its own, and the held id is logged',
    async (_, age) => {
      // Another account's held report, filed first, must not be the one named.
      seed({ userId: 202, images: [{ id: 9 }], ...claimedAgo(60) });
      const held = seed({ userId: 101, images: [{ id: 1 }], ...claimedAgo(age) });

      await createCsamReport({ userId: 101, reportedById: MOD, type: 'Image', imageIds: [4] });

      expect(rows.find((r) => r.id === held.id)).toEqual(held);
      expect(rows).toHaveLength(3);
      expect(rows[2]).toMatchObject({ userId: 101, images: [{ id: 4 }], sendClaimId: null });
      expect(skipLines()).toEqual([
        expect.objectContaining({ reportId: held.id, newReportId: rows[2].id }),
      ]);
    }
  );

  it('takes no filing when the claim lands between the lookup and the lock', async () => {
    const raced = seed({ userId: 101, images: [{ id: 1 }] });
    tx.csamReport.findFirst.mockImplementationOnce(async () => {
      Object.assign(rows.find((r) => r.id === raced.id)!, claimedAgo(0));
      return { id: raced.id };
    });

    await createCsamReport({ userId: 101, reportedById: MOD, type: 'Image', imageIds: [4] });

    expect(rows.find((r) => r.id === raced.id)).toMatchObject({ images: [{ id: 1 }] });
    expect(rows).toHaveLength(2);
    expect(tx.csamReport.update).not.toHaveBeenCalled();
    expect(skipLines()).toEqual([expect.objectContaining({ reportId: raced.id })]);
  });

  it('folds the next filing into the unsent report filed meanwhile, not a third', async () => {
    seed({ userId: 101, images: [{ id: 1 }], ...claimedAgo(60) });
    const meanwhile = seed({ userId: 101, images: [{ id: 2 }] });

    await createCsamReport({ userId: 101, reportedById: MOD, type: 'Image', imageIds: [4] });

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === meanwhile.id)).toMatchObject({
      images: [{ id: 2 }, { id: 4 }],
    });
  });

  it('takes a filing once the claim has expired, and clears the claim so its run cannot mark it sent', async () => {
    const stale = seed({
      userId: 101,
      images: [{ id: 1 }],
      ...claimedAgo(CSAM_SEND_CLAIM_EXPIRY_SECONDS + 60),
    });

    await createCsamReport({ userId: 101, reportedById: MOD, type: 'Image', imageIds: [4] });

    expect(rows).toHaveLength(1);
    expect(rows.find((r) => r.id === stale.id)).toMatchObject({
      images: [{ id: 1 }, { id: 4 }],
      sendClaimId: null,
      sendClaimedAt: null,
    });
    expect(skipLines()).toEqual([]);
  });
});
