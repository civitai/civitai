import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import type * as KyselyDb from '~/server/db/kyselyDb';
import type { CreateReportInput } from '~/server/schema/report.schema';
import { ReportReason } from '~/shared/utils/prisma/enums';
import { ReportEntity } from '~/shared/utils/report-helpers';

// docs/features/music.md (The song menu): a song report carries the time it is about.

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
const HIDDEN_SONG = 4;
const HIDDEN_IMAGE = 5;
const VISIBLE = [SONG, IMAGE, SONG_NO_LENGTH];

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, type text NOT NULL, metadata jsonb);
    INSERT INTO "Image" VALUES
      (${SONG}, 'audio', '{"duration": 180}'),
      (${IMAGE}, 'image', '{}'),
      (${SONG_NO_LENGTH}, 'audio', '{}'),
      (${HIDDEN_SONG}, 'audio', '{"duration": 180}'),
      (${HIDDEN_IMAGE}, 'image', '{}');
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

const user = { id: 52, isModerator: false };
const withMusic = { user, features: { music: true }, track: { report: vi.fn() } } as never;
const withoutMusic = { user, features: { music: false }, track: { report: vi.fn() } } as never;
const report = (
  input: Partial<CreateReportInput> & { details: Record<string, unknown> },
  ctx = withMusic
) =>
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
  // assertImageReportable's read: an image on no service review.
  dbMock.dbWrite.$queryRaw.mockImplementation(((strings: TemplateStringsArray) =>
    Promise.resolve(
      Array.isArray(strings) && strings.join('').includes('"ServiceDealReviewImage"')
        ? [{ buyerId: 9, sellerId: null, visible: null }]
        : []
    )) as never);
  dbMock.dbWrite.report.findFirst.mockResolvedValue(null);
  // A TOS report hides the image for its reporter.
  dbMock.dbWrite.imageEngagement.create.mockResolvedValue({} as never);
  reportCreate.mockResolvedValue({ id: 74, status: 'Pending', details: {} });
  // The visibility read: the reporter may open every image but the hidden ones.
  dbMock.dbRead.$queryRaw.mockResolvedValue(VISIBLE.map((id) => ({ id, userId: 9 })) as never);
  dbMock.dbRead.placement.findFirst.mockResolvedValue({ id: 115 } as never);
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
    await report({ details: { violation: 'Graphic violence', timestampSec: 180 } });
    expect(filedDetails()).toMatchObject({ timestampSec: 180 });
    reportCreate.mockClear();
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

describe('a sticker report on a song', () => {
  // About the placement, not a moment in the song.
  it('files without a time, and is refused one', async () => {
    const sticker = { reason: ReportReason.StickerPlacement } as const;
    await report({ ...sticker, details: { placementId: 115, target: 'sticker' } });
    expect(reportCreate).toHaveBeenCalledTimes(1);
    reportCreate.mockClear();
    await expect(
      report({ ...sticker, details: { placementId: 115, target: 'sticker', timestampSec: 5 } })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Only a report on a song can carry a time.',
    });
    expect(reportCreate).not.toHaveBeenCalled();
  });
});

describe('a song the reporter cannot open', () => {
  // The answer must not tell a hidden song from a hidden image.
  it('is refused a time exactly as a hidden image is', async () => {
    const details = { violation: 'Graphic violence', timestampSec: 500 };
    const song = await report({ id: HIDDEN_SONG, details }).catch((e) => e);
    const image = await report({ id: HIDDEN_IMAGE, details }).catch((e) => e);
    expect(song).toMatchObject({ code: image.code, message: image.message });
    expect(song).toMatchObject({ message: 'Only a report on a song can carry a time.' });
  });

  it('files without a time, like an image', async () => {
    await report({ id: HIDDEN_SONG, details: { violation: 'Graphic violence' } });
    expect(reportCreate).toHaveBeenCalledTimes(1);
  });
});

describe('a reporter without the music feature', () => {
  it('files a song report without a time, like an image report', async () => {
    await report({ details: { violation: 'Graphic violence' } }, withoutMusic);
    expect(reportCreate).toHaveBeenCalledTimes(1);
    expect(filedDetails()).not.toHaveProperty('timestampSec');
  });

  it('has the song rules with the feature on', async () => {
    await expect(report({ details: { violation: 'Graphic violence' } })).rejects.toMatchObject({
      message: 'Say when in the song this happens.',
    });
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
