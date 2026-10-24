import { describe, expect, it } from 'vitest';
import {
  POST_BATCH_CHUNK_MAX_IMAGES,
  POST_BATCH_CHUNK_POSTS,
  POST_BATCH_MIN_EVERY_MINUTES,
  POST_BATCH_MIN_GAP_MINUTES,
  seededRng,
  utcDayKey,
  validateBatchSchedule,
} from '@civitai/shared/post-scheduling';
import {
  chunkPosts,
  chunkSizeFor,
  defaultScheduleStart,
  describeLevelCounts,
  describeServerError,
  expandTitleTemplate,
  fixSpacing,
  generateBatchDates,
  groupIntoPosts,
  isEmptyDraft,
  isPostable,
  parseDraft,
  scanPollInterval,
  serializeDraft,
  shuffle,
  toBatchImage,
  toPersistImage,
} from '~/components/Post/Batch/batch-composer.utils';
import type {
  BatchMedia,
  ComposerDraft,
  PostableMedia,
  UploadedMedia,
} from '~/components/Post/Batch/batch-composer.utils';
import { NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const date = (iso: string) => new Date(iso);
const inMinutes = (minutes: number, from: Date) => new Date(from.getTime() + minutes * 60_000);

describe('expandTitleTemplate', () => {
  const tokens = {
    n: 3,
    total: 20,
    model: 'Neon Noir',
    version: 'v2.0',
    date: date('2026-10-07T15:07:00Z'),
  };

  it('replaces every token', () => {
    expect(expandTitleTemplate('{model} {version} — {n}/{total}', tokens)).toBe(
      'Neon Noir v2.0 — 3/20'
    );
  });

  it('drops a missing model without leaving double spaces', () => {
    expect(expandTitleTemplate('{model} — {n}', { ...tokens, model: null })).toBe('— 3');
  });

  it('formats {date} as a readable day', () => {
    expect(expandTitleTemplate('{date}', tokens)).toMatch(/Oct \d{1,2}, 2026/);
  });

  it('leaves unknown braces as typed', () => {
    expect(expandTitleTemplate('{nope} {n}', tokens)).toBe('{nope} 3');
  });
});

describe('groupIntoPosts', () => {
  it('fills groups in order and keeps the remainder', () => {
    expect(groupIntoPosts([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('treats a size under one as one per post', () => {
    expect(groupIntoPosts([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('chunkSizeFor', () => {
  it('goes one at a time for a small batch and caps at the server limit', () => {
    expect(chunkSizeFor(6)).toBe(1);
    expect(chunkSizeFor(12)).toBe(2);
    expect(chunkSizeFor(50)).toBe(7);
    expect(chunkSizeFor(200)).toBe(10);
  });
});

describe('chunkPosts', () => {
  const post = (images: number) => ({ images: new Array(images).fill(0) });

  it('caps a chunk at the post limit', () => {
    const chunks = chunkPosts(new Array(25).fill(null).map(() => post(1)));
    expect(chunks.map((chunk) => chunk.length)).toEqual([POST_BATCH_CHUNK_POSTS, 10, 5]);
  });

  it('starts a new chunk when the next post would exceed the image limit', () => {
    const chunks = chunkPosts([post(20), post(20), post(20), post(20)]);
    expect(chunks.map((chunk) => chunk.reduce((n, p) => n + p.images.length, 0))).toEqual([60, 20]);
    expect(chunks[0].length * 20).toBeLessThanOrEqual(POST_BATCH_CHUNK_MAX_IMAGES);
  });

  it('never splits a post and keeps order', () => {
    const posts = [post(3), post(1), post(2)];
    expect(chunkPosts(posts, { maxPosts: 2, maxImages: 4 })).toEqual([
      [posts[0], posts[1]],
      [posts[2]],
    ]);
  });
});

describe('shuffle', () => {
  it('is a permutation driven by the rng', () => {
    const result = shuffle([1, 2, 3, 4, 5, 6], seededRng(7));
    expect([...result].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result).toEqual(shuffle([1, 2, 3, 4, 5, 6], seededRng(7)));
  });
});

describe('defaultScheduleSettings', () => {
  it('starts at a requested future day and ignores one inside the lead', async () => {
    const { defaultScheduleSettings } = await import('../batch-composer.utils');
    const now = date('2026-10-07T15:02:30Z');
    const nextWeek = date('2026-10-14T00:00:00Z');
    expect(defaultScheduleSettings(now, nextWeek).start).toEqual(nextWeek);
    expect(defaultScheduleSettings(now, date('2026-10-07T15:05:00Z')).start.toISOString()).toBe(
      '2026-10-07T15:30:00.000Z'
    );
    expect(defaultScheduleSettings(now, null).start.toISOString()).toBe('2026-10-07T15:30:00.000Z');
  });
});

describe('defaultScheduleStart', () => {
  it('rounds up to the next quarter hour at least 20 minutes out', () => {
    const now = date('2026-10-07T15:02:30Z');
    const start = defaultScheduleStart(now);
    expect(start.getTime() - now.getTime()).toBeGreaterThanOrEqual(20 * 60_000);
    expect(start.getMinutes() % 15).toBe(0);
    expect(start.getSeconds()).toBe(0);
  });

  it('keeps a boundary that already satisfies the lead', () => {
    expect(defaultScheduleStart(date('2026-10-07T15:10:00Z')).toISOString()).toBe(
      '2026-10-07T15:30:00.000Z'
    );
  });
});

describe('generateBatchDates', () => {
  it('never lands on the hour and is deterministic per seed', () => {
    const settings = {
      mode: 'every' as const,
      start: date('2026-10-07T15:00:00Z'),
      every: 4,
      unit: 'hours' as const,
      from: date('2026-10-07T15:00:00Z'),
      to: date('2026-11-06T15:00:00Z'),
    };
    const first = generateBatchDates(settings, 30, 42);
    const again = generateBatchDates(settings, 30, 42);
    expect(first.ok && again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(first.dates.map((d) => d.getTime())).toEqual(again.dates.map((d) => d.getTime()));
    expect(first.dates.every((d) => d.getUTCMinutes() !== 0)).toBe(true);
  });

  it('reports an issue for a cadence the jitter could collapse below the gap', () => {
    const result = generateBatchDates(
      {
        mode: 'every',
        start: date('2026-10-07T15:00:00Z'),
        every: POST_BATCH_MIN_EVERY_MINUTES - 1,
        unit: 'minutes',
        from: new Date(),
        to: new Date(),
      },
      3,
      1
    );
    expect(result.ok).toBe(false);
  });
});

describe('fixSpacing', () => {
  const now = date('2026-10-07T12:00:00Z');

  it('pushes a post forward out of a gap violation, never backward', () => {
    const first = date('2026-10-07T15:07:00Z');
    const dates = [first, inMinutes(POST_BATCH_MIN_GAP_MINUTES - 1, first)];
    const { dates: fixed, moved } = fixSpacing({ dates, existing: [], dailyLimit: 10, now });
    expect(moved).toBe(1);
    expect(fixed[0]).toEqual(dates[0]);
    expect(fixed[1].getTime() - fixed[0].getTime()).toBeGreaterThanOrEqual(
      POST_BATCH_MIN_GAP_MINUTES * 60_000
    );
    expect(fixed[1] >= dates[1]).toBe(true);
  });

  it('moves a post off a day that is already at the cap, keeping it off :00', () => {
    const existing = [date('2026-10-08T01:05:00Z'), date('2026-10-08T02:05:00Z')];
    const dates = [date('2026-10-08T05:05:00Z')];
    const { dates: fixed } = fixSpacing({ dates, existing, dailyLimit: 2, now, rng: () => 0 });
    expect(utcDayKey(fixed[0])).toBe('2026-10-09');
    expect(fixed[0].getUTCMinutes()).not.toBe(0);
  });

  it('keeps the gap from an existing post', () => {
    const existing = [date('2026-10-07T18:00:00Z')];
    const dates = [inMinutes(POST_BATCH_MIN_GAP_MINUTES - 1, existing[0])];
    const { dates: fixed } = fixSpacing({ dates, existing, dailyLimit: 10, now });
    expect(fixed[0].getTime() - existing[0].getTime()).toBeGreaterThanOrEqual(
      POST_BATCH_MIN_GAP_MINUTES * 60_000
    );
  });

  it('produces a schedule the validator accepts and returns dates in input order', () => {
    const dates = [
      date('2026-10-07T15:07:00Z'),
      date('2026-10-07T15:09:00Z'),
      date('2026-10-07T15:11:00Z'),
      date('2026-10-07T15:13:00Z'),
    ];
    const { dates: fixed } = fixSpacing({
      dates,
      existing: [],
      dailyLimit: 2,
      now,
      rng: () => 0.5,
    });
    expect(fixed).toHaveLength(4);
    const result = validateBatchSchedule({
      now,
      publishedAts: fixed,
      existingPublishedAts: [],
      dailyLimit: 2,
    });
    expect(result.issues).toEqual([]);
    expect(fixed.every((d, i) => i === 0 || d > fixed[i - 1])).toBe(true);
  });
});

describe('toPersistImage', () => {
  const media = {
    status: 'added',
    url: 'abc-key',
    index: 1,
    name: 'a.png',
    mimeType: 'image/png',
    type: 'image',
    metadata: { width: 10, height: 20, hash: 'h' },
    meta: { prompt: 'x' },
    objectUrl: 'blob:1',
  } as unknown as UploadedMedia;

  it('reshapes the upload result to the image fields', () => {
    const image = toPersistImage(media);
    expect(image).toMatchObject({ url: 'abc-key', width: 10, height: 20, hash: 'h' });
    expect(image.meta).toEqual({ prompt: 'x' });
  });

  it('sends no meta when there is none', () => {
    expect(toPersistImage({ ...media, meta: undefined }).meta).toBeUndefined();
    expect(toPersistImage({ ...media, meta: {} }).meta).toBeUndefined();
  });
});

describe('toBatchImage', () => {
  it('sends only the draft row id', () => {
    expect(toBatchImage({ status: 'added', url: 'k', imageId: 9 } as PostableMedia)).toEqual({
      imageId: 9,
    });
  });
});

const item = (overrides: Partial<BatchMedia>): BatchMedia =>
  ({ status: 'added', url: `u-${Math.random()}`, imageId: 1, ...overrides } as BatchMedia);

describe('isPostable', () => {
  it('needs a persisted row that is not blocked', () => {
    expect(isPostable(item({}))).toBe(true);
    expect(isPostable(item({ ingestion: ImageIngestionStatus.Pending }))).toBe(true);
    expect(isPostable(item({ ingestion: ImageIngestionStatus.Error }))).toBe(true);
    expect(isPostable(item({ imageId: undefined }))).toBe(false);
    expect(isPostable(item({ persistFailed: true }))).toBe(false);
    expect(isPostable(item({ ingestion: ImageIngestionStatus.Blocked }))).toBe(false);
    expect(isPostable(item({ status: 'blocked', imageId: undefined }))).toBe(false);
    expect(isPostable(item({ status: 'error', imageId: undefined }))).toBe(false);
  });
});

describe('scanPollInterval', () => {
  const now = date('2026-10-07T12:00:00Z').getTime();

  it('polls every 5 s, slows to 15 s after three minutes and stops when nothing is pending', () => {
    expect(scanPollInterval({ pending: false, pendingSince: now - 10_000, now })).toBe(false);
    expect(scanPollInterval({ pending: true, pendingSince: null, now })).toBe(5_000);
    expect(scanPollInterval({ pending: true, pendingSince: now - 179_000, now })).toBe(5_000);
    expect(scanPollInterval({ pending: true, pendingSince: now - 180_000, now })).toBe(15_000);
  });
});

describe('describeLevelCounts', () => {
  it('counts rated, postable media by level in display order', () => {
    const media = [
      ...Array.from({ length: 3 }, () => item({ nsfwLevel: NsfwLevel.PG13 })),
      item({ nsfwLevel: NsfwLevel.R }),
      ...Array.from({ length: 12 }, () => item({ nsfwLevel: NsfwLevel.PG })),
      item({ nsfwLevel: 0 }),
      item({ nsfwLevel: NsfwLevel.X, ingestion: ImageIngestionStatus.Blocked }),
      item({ nsfwLevel: NsfwLevel.XXX, imageId: undefined }),
    ];
    expect(describeLevelCounts(media)).toBe('12 PG · 3 PG-13 · 1 R');
  });

  it('labels a composite level by its most severe bit and is empty with nothing rated', () => {
    expect(describeLevelCounts([item({ nsfwLevel: NsfwLevel.PG | NsfwLevel.R })])).toBe('1 R');
    expect(describeLevelCounts([item({})])).toBe('');
  });
});

describe('describeServerError', () => {
  it('maps the validator wording to the copy deck', () => {
    expect(describeServerError('2026-10-07 would have 7 posts; your daily limit is 6.')).toContain(
      'daily limit on 2026-10-07'
    );
    expect(
      describeServerError(
        'Post 2 goes live 10 minutes from post 1. Posts need at least 30 minutes between them.'
      )
    ).toContain('too close together');
    expect(describeServerError('Post 1 must be at least 10 minutes from now.')).toContain('window');
    expect(describeServerError('Something else')).toBe('Something else');
  });

  it('says nothing was created only when nothing was', () => {
    const tooClose = 'Post 1 is too close to a post you already have scheduled.';
    expect(describeServerError(tooClose)).toBe(
      'Two posts would be too close together. Nothing was created.'
    );
    expect(describeServerError(tooClose, 3)).toBe(
      'Two posts would be too close together. 3 posts were created before this.'
    );
  });
});

describe('promotedFromResource', () => {
  it('takes the model and version names off a picked resource', async () => {
    const { promotedFromResource } = await import('../batch-composer.utils');
    expect(promotedFromResource({ id: 42, name: 'v2.0', model: { name: 'Neon Noir' } })).toEqual({
      id: 42,
      model: 'Neon Noir',
      version: 'v2.0',
    });
    expect(
      expandTitleTemplate('{model} {version} — {n}', {
        n: 1,
        total: 1,
        ...promotedFromResource({ id: 42, name: 'v2.0', model: { name: 'Neon Noir' } }),
        date: date('2026-10-07T15:07:00Z'),
      })
    ).toBe('Neon Noir v2.0 — 1');
  });
});

describe('draft serialisation', () => {
  const now = date('2026-10-07T12:00:00Z');
  const media = (
    url: string,
    status: UploadedMedia['status'] | 'error',
    extra: Partial<BatchMedia> = { imageId: 100 }
  ) =>
    ({
      status,
      url,
      index: 1,
      name: `${url}.png`,
      mimeType: 'image/png',
      type: 'image',
      objectUrl: `blob:${url}`,
      metadata: { width: 10, height: 20, hash: 'h' },
      meta: { prompt: 'x' },
      ...extra,
    } as unknown as UploadedMedia);
  const draft = (): ComposerDraft => ({
    media: [
      media('a', 'added', {
        imageId: 1,
        ingestion: ImageIngestionStatus.Scanned,
        nsfwLevel: NsfwLevel.PG13,
        blockedFor: null,
        needsReview: null,
        minor: false,
        poi: false,
      }),
      media('b', 'added', { imageId: 2, ingestion: ImageIngestionStatus.Pending }),
    ],
    imagesPerPost: 2,
    shared: {
      promotedVersionId: 42,
      resources: [],
      tools: [{ id: 1, name: 'Comfy' }],
      techniques: [],
      tags: ['anime'],
      titleTemplate: '{model} — {n}',
    },
    presetId: 3,
    promotedNames: { model: 'Neon Noir', version: 'v2.0' },
    schedule: {
      mode: 'every',
      start: date('2026-10-08T15:00:00Z'),
      every: 4,
      unit: 'hours',
      from: date('2026-10-08T15:00:00Z'),
      to: date('2026-11-07T15:00:00Z'),
    },
    seed: 7,
    fixedDates: [date('2026-10-08T15:07:00Z'), date('2026-10-08T19:07:00Z')],
  });

  it('round-trips through JSON with its dates, image ids and scan fields intact and no blob URLs', () => {
    const serialized = JSON.parse(JSON.stringify(serializeDraft(draft())));
    expect(JSON.stringify(serialized)).not.toContain('blob:');
    const restored = parseDraft(serialized, now);
    expect(restored).toEqual({
      ...draft(),
      media: draft().media.map((item) => ({ ...item, objectUrl: '' })),
    });
    expect(restored?.media.map((item) => item.imageId)).toEqual([1, 2]);
    expect(restored?.media[0].nsfwLevel).toBe(NsfwLevel.PG13);
  });

  it('keeps only persisted uploads', () => {
    const serialized = serializeDraft({
      ...draft(),
      media: [
        media('a', 'added'),
        media('b', 'error', {}),
        media('c', 'added', { imageId: undefined }),
        media('d', 'added', { imageId: 7, persistFailed: true }),
      ],
    });
    expect(serialized.media.map((item) => item.url)).toEqual(['a', 'd']);
    expect('persistFailed' in serialized.media[1]).toBe(false);
  });

  it('drops a schedule and fixed dates that have already started', () => {
    const restored = parseDraft(serializeDraft(draft()), date('2026-10-08T16:00:00Z'));
    expect(restored?.schedule.start.getTime()).toBeGreaterThan(
      date('2026-10-08T16:00:00Z').getTime()
    );
    expect(restored?.fixedDates).toBeNull();
    expect(restored?.media).toHaveLength(2);
  });

  it('rejects anything it cannot read', () => {
    expect(parseDraft(undefined, now)).toBeNull();
    expect(parseDraft({ version: 2 }, now)).toBeNull();
    expect(parseDraft({ ...serializeDraft(draft()), media: [{ url: 'a' }] }, now)).toBeNull();
    const { imageId: _imageId, ...noId } = serializeDraft(draft()).media[0];
    expect(parseDraft({ ...serializeDraft(draft()), media: [noId] }, now)).toBeNull();
  });

  it('treats a draft with nothing in it as empty', () => {
    expect(isEmptyDraft(draft())).toBe(false);
    expect(
      isEmptyDraft({
        ...draft(),
        media: [],
        promotedNames: null,
        shared: { ...draft().shared, tools: [], tags: [] },
      })
    ).toBe(true);
  });
});
