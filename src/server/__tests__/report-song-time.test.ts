import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import type * as KyselyDb from '~/server/db/kyselyDb';
import type { CreateReportInput } from '~/server/schema/report.schema';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

// Music T10 S3 (odd/tasks/music-section-t10.md): a song report carries the time it is about.

// The song lookup is Kysely SQL; it runs against a real "Image" table.
const pg = { db: null as unknown as PGlite };
vi.mock('~/server/db/kyselyDb', async (importOriginal) => ({
  ...(await importOriginal<typeof KyselyDb>()),
  kyselyV3Read: pgliteKysely(() => pg.db),
}));
vi.setConfig({ hookTimeout: 60_000 });

const SONG = 1;
const IMAGE = 2;
const SONG_NO_LENGTH = 3;

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, type text NOT NULL, metadata jsonb);
    INSERT INTO "Image" VALUES
      (${SONG}, 'audio', '{"duration": 180}'),
      (${IMAGE}, 'image', '{}'),
      (${SONG_NO_LENGTH}, 'audio', '{}');
  `);
});
afterAll(async () => {
  await pg.db.close();
});

const reportCreate = vi.fn();
dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
  fn({ report: { create: (...args: unknown[]) => reportCreate(...args) } })
);

const { createReportHandler } = await import('~/server/controllers/report.controller');

const ctx = { user: { id: 52, isModerator: false }, track: { report: vi.fn() } } as never;
const report = (input: Partial<CreateReportInput> & { details: Record<string, unknown> }) =>
  createReportHandler({
    input: {
      type: ReportEntity.Image,
      id: SONG,
      reason: ReportReason.TOSViolation,
      ...input,
    } as CreateReportInput,
    ctx,
  });
const filedDetails = () => reportCreate.mock.calls[0]?.[0].data.details;

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.report.findFirst.mockResolvedValue(null);
  // A TOS report hides the image for its reporter.
  dbMock.dbWrite.imageEngagement.create.mockResolvedValue({} as never);
  reportCreate.mockResolvedValue({ id: 74, status: 'Pending', details: {} });
});

describe('a report on a song', () => {
  it('is filed with the time it is about', async () => {
    await expect(
      report({ details: { violation: 'Graphic violence', timestampSec: 42 } })
    ).resolves.toBeNull();
    expect(filedDetails()).toMatchObject({ violation: 'Graphic violence', timestampSec: 42 });
  });

  it('is refused without a time', async () => {
    await expect(report({ details: { violation: 'Graphic violence' } })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Say when in the song this happens.',
    });
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('is refused at a time past the end of the song', async () => {
    await expect(
      report({ details: { violation: 'Graphic violence', timestampSec: 181 } })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That time is past the end of the song.',
    });
    expect(reportCreate).not.toHaveBeenCalled();
  });

  it('is refused as a photorealistic depiction of a minor', async () => {
    await expect(
      report({
        details: { violation: 'Photorealistic depiction of a minor', timestampSec: 10 },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(reportCreate).not.toHaveBeenCalled();
  });

  // No stored length: the time cannot be bounded, and refusing would leave the song unreportable.
  it('takes any time when the song has no stored length', async () => {
    await report({
      id: SONG_NO_LENGTH,
      details: { violation: 'Graphic violence', timestampSec: 4000 },
    });
    expect(filedDetails()).toMatchObject({ timestampSec: 4000 });
  });
});

describe('a time on something that is not a song', () => {
  it('is refused on an image and on another entity', async () => {
    await expect(
      report({ id: IMAGE, details: { violation: 'Graphic violence', timestampSec: 5 } })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Only a report on a song can carry a time.',
    });
    await expect(
      report({
        type: ReportEntity.Model,
        id: 9,
        details: { violation: 'Graphic violence', timestampSec: 5 },
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Only a report on a song can carry a time.',
    });
    expect(reportCreate).not.toHaveBeenCalled();
  });
});

describe('a report on an image', () => {
  it('is filed without a time, as before', async () => {
    await report({
      id: IMAGE,
      details: { violation: 'Photorealistic depiction of a minor' },
    });
    expect(reportCreate).toHaveBeenCalledTimes(1);
    expect(filedDetails()).toMatchObject({ violation: 'Photorealistic depiction of a minor' });
    expect(filedDetails()).not.toHaveProperty('timestampSec');
  });
});
