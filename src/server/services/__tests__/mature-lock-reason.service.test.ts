import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { autoNsfwTextHash } from '~/server/services/auto-nsfw';
import { getMatureLockReason } from '~/server/services/mature-lock-reason.service';

const OWNER = 10;
const LOCKED_AT = '2026-01-01T00:00:00.000Z';

const model = (overrides: Record<string, unknown> = {}, marker: Record<string, unknown> = {}) => ({
  id: 1,
  userId: OWNER,
  nsfw: true,
  lockedProperties: ['nsfw'],
  minor: false,
  poi: false,
  sfwOnly: false,
  name: 'model name',
  description: 'model description',
  meta: {
    profanityMatches: ['PLACEHOLDER_MATCHED_TERM'],
    profanityEvaluation: { reason: 'PLACEHOLDER_RULE_REASON', metrics: {} },
    systemNsfwLock: {
      source: 'profanity-filter',
      at: LOCKED_AT,
      fields: ['name'],
      category: 'mature-language',
      textHash: autoNsfwTextHash('model name', 'model description'),
      ...marker,
    },
  },
  ...overrides,
});

const reason = (m = model(), ...viewer: [number | undefined] | []) =>
  getMatureLockReason({ model: m, viewerId: viewer.length ? viewer[0] : OWNER });

beforeEach(() => {
  dbMock.dbRead.appeal.findMany.mockResolvedValue([]);
  dbMock.dbRead.ratingReview.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.modActivity.findFirst.mockResolvedValue(null);
});

describe('getMatureLockReason', () => {
  it('tells the owner the field and category of a mature text lock, and nothing else', async () => {
    const result = await reason();

    // Strict: no matched text, rule, score or hash rides along.
    expect(result).toStrictEqual({ fields: ['name'], category: 'mature-language' });
  });

  it.each([
    ['a visitor', undefined],
    ['another user', 20],
  ])('gives %s nothing', async (_, viewer) => {
    expect(await reason(model(), viewer)).toBeNull();
  });

  it.each([
    ['minor', { minor: true }],
    ['POI', { poi: true }],
    ['SFW-only', { sfwOnly: true }],
    ['minor-locked', { lockedProperties: ['nsfw', 'minor'] }],
    ['POI-locked', { lockedProperties: ['nsfw', 'poi'] }],
    ['SFW-only-locked', { lockedProperties: ['nsfw', 'sfwOnly'] }],
  ])('says nothing new on a %s model', async (_, overrides) => {
    expect(await reason(model(overrides))).toBeNull();
  });

  it('says nothing for an nsfw lock another check set', async () => {
    expect(await reason(model({}, { source: 'text-scan' }))).toBeNull();
  });

  it('says nothing once the nsfw lock is gone', async () => {
    expect(await reason(model({ lockedProperties: [] }))).toBeNull();
  });

  it('says nothing for a lock stored before fields were recorded', async () => {
    expect(
      await reason(model({}, { fields: undefined, category: undefined, textHash: undefined }))
    ).toBeNull();
  });

  it('says nothing for a marker that names no field', async () => {
    expect(await reason(model({}, { fields: [] }))).toBeNull();
  });

  it.each([
    ['name', { name: 'renamed' }],
    ['description', { description: 'rewritten' }],
  ])('says nothing once the %s changed since the lock', async (_, overrides) => {
    expect(await reason(model(overrides))).toBeNull();
  });

  it('shows the outcome only once a lock review naming nsfw was ruled on', async () => {
    dbMock.dbRead.appeal.findMany.mockResolvedValue([
      { context: { kind: 'lock-review', locks: ['nsfw'] } },
    ]);
    expect(await reason()).toBeNull();
  });

  it('a ruled lock review of other settings leaves the reason up', async () => {
    dbMock.dbRead.appeal.findMany.mockResolvedValue([
      { context: { kind: 'lock-review', locks: ['tags'] } },
    ]);
    expect(await reason()).toStrictEqual({ fields: ['name'], category: 'mature-language' });
  });

  it('says nothing once a moderator acted on the nsfw lock after it was set', async () => {
    dbMock.dbWrite.modActivity.findFirst.mockResolvedValue({ id: 9 });
    expect(await reason()).toBeNull();
  });

  it('shows the outcome only once a rating review was ruled on', async () => {
    dbMock.dbRead.ratingReview.findFirst.mockResolvedValue({ id: 5 });
    expect(await reason()).toBeNull();
  });

  it("counts only this model's lock reviews and rating reviews ruled at or after the lock", async () => {
    await reason();
    const since = { gte: new Date(LOCKED_AT) };
    expect(dbMock.dbRead.appeal.findMany.mock.calls[0][0].where).toStrictEqual({
      entityType: 'Model',
      entityId: 1,
      resolvedAt: since,
      context: { path: ['kind'], equals: 'lock-review' },
    });
    expect(dbMock.dbRead.ratingReview.findFirst.mock.calls[0][0].where).toStrictEqual({
      entityType: 'Model',
      entityId: 1,
      resolvedAt: since,
    });
  });
});
