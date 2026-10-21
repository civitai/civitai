import { describe, expect, it } from 'vitest';
import { placementNotifications } from '~/server/notifications/placement.notifications';

/**
 * The three owner-facing sticker notifications name what the sticker is on.
 * A video is an image row, so the noun cannot come from the target type: it rides
 * in `details.mediaType`, selected by each query, and the message reads it.
 */
const OWNER_TYPES = [
  ['sticker-placement-pending', { amount: 700 }],
  ['sticker-placement-free-pending', {}],
  ['sticker-placement-auto-accepted', {}],
] as const;

const messageFor = (type: string, extra: object, mediaType?: string) =>
  placementNotifications[type].prepareMessage({
    details: {
      placementId: 5,
      imageId: 74,
      placerId: 52,
      placerUsername: 'someone',
      ...extra,
      ...(mediaType ? { mediaType } : {}),
    },
  })!.message;

const queryFor = async (type: string) =>
  (await placementNotifications[type].prepareQuery!({
    lastSent: '2026-01-01',
    lastSentDate: new Date('2026-01-01'),
    clickhouse: undefined,
  })) as string;

describe.each(OWNER_TYPES)('%s', (type, extra) => {
  it('says video for a video', () => {
    expect(messageFor(type, extra, 'video')).toMatch(/on your video\b/);
    expect(messageFor(type, extra, 'video')).not.toMatch(/image/);
  });

  it('says image for an image', () => {
    expect(messageFor(type, extra, 'image')).toMatch(/on your image\b/);
  });

  // Notifications already written before the field existed carry none, and an
  // image is what they were written about.
  it('says image when the row names no media type', () => {
    expect(messageFor(type, extra)).toMatch(/on your image\b/);
  });

  // Without the field in the query every message above would read "image" in
  // production while these message tests stayed green.
  it('selects the media type from the image', async () => {
    const query = await queryFor(type);

    expect(query).toContain(`'mediaType', i.type::text`);
    // Left, so an image deleted since the placement still gets its notification.
    expect(query).toContain(`LEFT JOIN "Image" i ON i.id = p."targetId"`);
  });
});
