import { describe, it, expect } from 'vitest';
import {
  imageReviewedSql,
  isImageReviewed,
  KNIGHTS_VOTE_NSFW_LEVEL_REASON,
  withServableImage,
} from '~/server/common/image-visibility';

const render = (alias?: string) => {
  const sql = alias ? imageReviewedSql(alias) : imageReviewedSql();
  return sql.strings
    .reduce((acc, s, i) => acc + s + (i < sql.values.length ? String(sql.values[i]) : ''), '')
    .replace(/\s+/g, ' ')
    .trim();
};

describe('imageReviewedSql', () => {
  // Pins the whole shape, not keywords: a string match still passes with OR and AND swapped,
  // which would expose every mod-rated ToS removal.
  it('renders scanned OR (mod-rated AND not terminal AND not an unqualified Error lock)', () => {
    expect(render()).toBe(
      '( "i"."ingestion" = Scanned::"ImageIngestionStatus" ' +
        'OR ( "i"."nsfwLevelLocked" = TRUE ' +
        'AND "i"."ingestion" NOT IN (Blocked::"ImageIngestionStatus",NotFound::"ImageIngestionStatus") ' +
        'AND NOT ( "i"."ingestion" = Error::"ImageIngestionStatus" ' +
        `AND ( COALESCE("i"."metadata"->>'nsfwLevelReason', '') = Knights Vote ` +
        `OR ( COALESCE("i"."scanJobs"->'error'->>'failureClass', '') = permanent ` +
        `OR COALESCE("i"."scanJobs"->'lastFailure'->>'failureClass', '') = permanent ` +
        `OR COALESCE("i"."scanJobs"->'permanentFailure' = 'true'::jsonb, FALSE) ) ) ) ) )`
    );
  });

  it('keeps the terminal exclusion inside the mod-rated branch, not the top level', () => {
    const sql = render();
    const orIndex = sql.indexOf('OR');
    // Both halves of the mod-rated branch must sit after the OR: if NOT IN escaped to
    // the top level it would filter Scanned images too, and if the AND became an OR a
    // mod rating alone would satisfy the predicate.
    expect(sql.indexOf('nsfwLevelLocked')).toBeGreaterThan(orIndex);
    expect(sql.indexOf('NOT IN')).toBeGreaterThan(sql.indexOf('nsfwLevelLocked'));
    expect(sql).not.toMatch(/nsfwLevelLocked"\s*=\s*TRUE\s*\)?\s*OR/);
  });

  it('honours an alias override', () => {
    expect(render('img')).toContain('"img"."ingestion"');
    expect(render('img')).not.toContain('"i"."ingestion"');
  });
});

describe('isImageReviewed', () => {
  const locked = { nsfwLevelLocked: true } as const;

  it.each([
    ['a completed scan', { ingestion: 'Scanned', nsfwLevelLocked: false }, true],
    ['a mod lock on a stalled scan', { ingestion: 'Pending', ...locked }, true],
    [
      'a Knights lock on a stalled scan',
      { ingestion: 'Pending', ...locked, nsfwLevelReason: KNIGHTS_VOTE_NSFW_LEVEL_REASON },
      true,
    ],
    ['a mod lock on an errored scan', { ingestion: 'Error', ...locked }, true],
    [
      'a Knights lock on an errored scan',
      { ingestion: 'Error', ...locked, nsfwLevelReason: KNIGHTS_VOTE_NSFW_LEVEL_REASON },
      false,
    ],
    [
      'a mod lock on a permanently failed scan',
      { ingestion: 'Error', ...locked, scanJobs: { error: { failureClass: 'permanent' } } },
      false,
    ],
    [
      'a mod lock on a re-submitted permanent failure that errored again',
      {
        ingestion: 'Error',
        ...locked,
        scanJobs: {
          error: { failureClass: 'transient' },
          lastFailure: { failureClass: 'permanent' },
        },
      },
      false,
    ],
    [
      'a mod lock on an errored scan once kept as a permanent failure',
      {
        ingestion: 'Error',
        ...locked,
        scanJobs: { error: { failureClass: 'transient' }, permanentFailure: true },
      },
      false,
    ],
    [
      'a mod lock on an errored scan after an earlier transient failure',
      {
        ingestion: 'Error',
        ...locked,
        scanJobs: {
          error: { failureClass: 'transient' },
          lastFailure: { failureClass: 'transient' },
        },
      },
      true,
    ],
    [
      'a completed scan after an earlier permanent failure',
      {
        ingestion: 'Scanned',
        nsfwLevelLocked: false,
        scanJobs: { lastFailure: { failureClass: 'permanent' } },
      },
      true,
    ],
    ['an errored scan with no lock', { ingestion: 'Error', nsfwLevelLocked: false }, false],
    ['a mod lock on a ToS removal', { ingestion: 'Blocked', ...locked }, false],
    ['a mod lock on missing media', { ingestion: 'NotFound', ...locked }, false],
  ] as const)('%s → %s', (_label, input, expected) => {
    expect(isImageReviewed({ nsfwLevelReason: null, scanJobs: null, ...input })).toBe(expected);
  });
});

describe('withServableImage', () => {
  const UPLOADER = 5;
  const image = (nsfwLevel: number, modelRestricted = true) => ({
    id: 1,
    nsfwLevel,
    modelRestricted,
    userId: UPLOADER,
  });
  const row = (cover: ReturnType<typeof image> | null, hero = image(4)) => ({
    id: 9,
    name: 'n',
    meta: { a: 1 },
    cover,
    hero,
  });

  it('withholds a mature restricted image from anyone but its uploader, leaving the rest alone', () => {
    const input = row(image(4));
    for (const viewerId of [6, null, undefined]) {
      expect(withServableImage(input, 'cover', viewerId)).toEqual({ ...input, cover: null });
    }
    expect(withServableImage(input, 'cover', UPLOADER)).toEqual(input);
    expect(input.cover).toEqual(image(4));
  });

  it('serves a SFW or unflagged image to anyone, and keeps a missing one missing', () => {
    expect(withServableImage(row(image(1)), 'cover').cover).toEqual(image(1));
    expect(withServableImage(row(image(4, false)), 'cover').cover).toEqual(image(4, false));
    expect(withServableImage(row(null), 'cover').cover).toBeNull();
  });

  it('judges each key on its own when nested', () => {
    const served = withServableImage(withServableImage(row(image(1)), 'cover', 6), 'hero', 6);
    expect([served.cover, served.hero]).toEqual([image(1), null]);
  });
});
