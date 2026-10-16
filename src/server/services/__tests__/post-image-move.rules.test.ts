import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { POST_IMAGE_LIMIT } from '~/server/common/constants';
import type { MoveImageRow, MovePostRow } from '~/server/services/post-image-move.rules';
import { getImageMoveRefusal } from '~/server/services/post-image-move.rules';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const USER = 7;
const NOW = new Date('2026-10-14T12:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const post = (over: Partial<MovePostRow> = {}): MovePostRow => ({
  id: 1,
  userId: USER,
  publishedAt: day(10),
  tosViolation: false,
  isContest: false,
  ...over,
});
const image = (over: Partial<MoveImageRow> = {}): MoveImageRow => ({
  id: 100,
  userId: USER,
  postId: 1,
  tosViolation: false,
  ingestion: ImageIngestionStatus.Scanned,
  ...over,
});

function refusal(over: Partial<Parameters<typeof getImageMoveRefusal>[0]> = {}) {
  const images = over.images ?? [image()];
  return getImageMoveRefusal({
    userId: USER,
    imageIds: images.map((i) => i.id),
    source: post(),
    target: post({ id: 2, publishedAt: day(20) }),
    images,
    targetImageCount: 0,
    now: NOW,
    ...over,
  });
}

describe('getImageMoveRefusal', () => {
  it('allows moving into an older published post of the same owner', () => {
    expect(refusal()).toBeNull();
  });

  it('allows moving into a new post (target null)', () => {
    expect(refusal({ target: null })).toBeNull();
  });

  it('allows a target published at exactly the source date', () => {
    expect(refusal({ target: post({ id: 2, publishedAt: day(10) }) })).toBeNull();
  });

  it.each([
    ['missing source', { source: undefined }, 'not-found'],
    ['missing target', { target: undefined }, 'not-found'],
    ['same post', { target: post({ id: 1 }) }, 'bad-request'],
    ['someone else’s source post', { source: post({ userId: 8 }) }, 'unauthorized'],
    ['someone else’s target post', { target: post({ id: 2, userId: 8 }) }, 'unauthorized'],
    ['someone else’s image', { images: [image({ userId: 8 })] }, 'unauthorized'],
    ['an image that does not exist', { imageIds: [100, 101] }, 'unauthorized'],
    ['an image from another post', { images: [image({ postId: 3 })] }, 'bad-request'],
    ['a contest source', { source: post({ isContest: true }) }, 'bad-request'],
    ['a contest target', { target: post({ id: 2, isContest: true }) }, 'bad-request'],
    ['a ToS-violating source', { source: post({ tosViolation: true }) }, 'bad-request'],
    [
      'a blocked image',
      { images: [image({ ingestion: ImageIngestionStatus.Blocked })] },
      'bad-request',
    ],
    ['a ToS-violating image', { images: [image({ tosViolation: true })] }, 'bad-request'],
    ['a draft source', { source: post({ publishedAt: null }) }, 'bad-request'],
    ['a scheduled source', { source: post({ publishedAt: day(-1) }) }, 'bad-request'],
    ['a draft target', { target: post({ id: 2, publishedAt: null }) }, 'bad-request'],
    ['a scheduled target', { target: post({ id: 2, publishedAt: day(-1) }) }, 'bad-request'],
    ['a newer target', { target: post({ id: 2, publishedAt: day(5) }) }, 'bad-request'],
    ['a full target', { targetImageCount: POST_IMAGE_LIMIT }, 'bad-request'],
  ] as const)('refuses %s', (_, over, kind) => {
    expect(refusal(over as Partial<Parameters<typeof getImageMoveRefusal>[0]>)?.kind).toBe(kind);
  });

  it('counts the moved images against the target cap', () => {
    const images = [image({ id: 100 }), image({ id: 101 })];
    expect(refusal({ images, targetImageCount: POST_IMAGE_LIMIT - 2 })).toBeNull();
    expect(refusal({ images, targetImageCount: POST_IMAGE_LIMIT - 1 })?.kind).toBe('bad-request');
  });
});

describe('a permitted move never raises Image.sortAt', () => {
  // Mirrors set_image_sort_at(); the text pin below fails if the trigger's formula changes.
  const sortAt = (postPublishedAt: Date | null, scannedAt: Date | null, createdAt: Date) =>
    Math.max(
      ...[postPublishedAt, scannedAt, createdAt].filter((d): d is Date => !!d).map((d) => +d)
    );

  it('still matches the trigger formula', () => {
    const sql = readFileSync(
      path.resolve(
        __dirname,
        '../../../../packages/civitai-db-schema/prisma/programmability/image_post_triggers.sql'
      ),
      'utf8'
    );
    expect(sql).toMatch(
      /NEW\."sortAt" := GREATEST\(post_published_at, NEW\."scannedAt", NEW\."createdAt"\);/
    );
  });

  const offsets = [0, 1, 5, 10, 15, 30, 400];
  it('holds for every source/target/scan/create combination the rule admits', () => {
    let admitted = 0;
    let refusedBump = 0;
    for (const s of offsets)
      for (const t of [...offsets, null])
        for (const scanned of [...offsets, null])
          for (const created of offsets) {
            const source = post({ publishedAt: day(s) });
            const target = t === null ? null : post({ id: 2, publishedAt: day(t) });
            if (refusal({ source, target })) {
              refusedBump++;
              continue;
            }
            admitted++;
            const scannedAt = scanned === null ? null : day(scanned);
            const before = sortAt(source.publishedAt, scannedAt, day(created));
            // A new post (target null) is published at the source's date.
            const after = sortAt(
              target ? target.publishedAt : source.publishedAt,
              scannedAt,
              day(created)
            );
            expect(after).toBeLessThanOrEqual(before);
          }
    // Both arms exercised, so the loop cannot pass vacuously.
    expect(admitted).toBeGreaterThan(0);
    expect(refusedBump).toBeGreaterThan(0);
  });
});
