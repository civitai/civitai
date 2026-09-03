import { describe, expect, it } from 'vitest';
import { parseImageQueryParams, imagesQueryParamSchema } from '~/components/Image/image.utils';
import { reactionNotifications } from '~/server/notifications/reaction.notifications';

/**
 * One bad link, both halves of it.
 *
 * `image-reaction-milestone` interpolated `details.postId` into the URL
 * unconditionally. An image that is not in a post — an article cover, most of
 * them; 25,135 such images on prod on 2026-09-03 — has `postId = null`, which
 * template-interpolates to the literal string `null`. `/images/[imageId]` then
 * fed that to `numericString`, `Number('null')` came back NaN, the schema threw
 * mid-render, and the notification link Civitai had just mailed the user
 * returned a 500. Measured on prod before the fix: `/images/140935761` -> 200,
 * `/images/140935761?postId=null` -> 500, `?postId=abc` -> 500.
 *
 * 🔴 To whoever is about to simplify one of these away: they are NOT redundant.
 * Fixing only the page leaves the app still minting `?postId=null` links. Fixing
 * only the emitter leaves every copy of a bad link that has escaped the app —
 * shared, bookmarked, crawled, or mailed out by the external notifications
 * service — still landing on a 500, and leaves `?postId=abc` from any source
 * broken too.
 *
 * ⚠️ An earlier version of this comment claimed delivered links "cannot be
 * rewritten". That is wrong and the correction is kept because it changes what a
 * rollback costs: the URL is not stored, `getNotificationMessage` recomputes it at
 * render from the stored `details` JSON, so the emitter fix IS retroactive for
 * in-app notifications.
 *
 * ⚠️ These tests assert the emitter and the helper. They do NOT pin the page's
 * call site — reverting `[imageId].tsx` to a bare `.parse` while leaving the helper
 * exported and unused keeps every test here green and restores the production 500.
 * That call site is pinned by the convention guard
 * `src/server/services/__tests__/no-throwing-image-query-parse.test.ts`. Do not
 * read this file as covering it.
 */

const urlFor = (postId: number | null) =>
  (
    reactionNotifications['image-reaction-milestone'].prepareMessage({
      type: 'image-reaction-milestone',
      details: { imageId: 140935761, postId, reactionCount: 100, version: 2 },
    } as Parameters<Def['prepareMessage']>[0]) as { url: string }
  ).url;

describe('half 1 — the emitter stops minting the bad link', () => {
  it('omits postId entirely when the image is in no post', () => {
    // On revert this reads `/images/140935761?postId=null` and names the wrong value.
    expect(urlFor(null)).toBe('/images/140935761');
  });

  it('never emits the literal string "null" as a param value', () => {
    expect(urlFor(null)).not.toMatch(/postId=(null|undefined|NaN)/);
  });

  it('still carries a real postId, because that is what the link is for', () => {
    expect(urlFor(9876)).toBe('/images/140935761?postId=9876');
  });
});

describe('half 2 — the page survives a link already delivered', () => {
  // The control for the two tests below: the schema really does reject this, so
  // a bare `.parse` really would throw. Without this, the safeParse assertions
  // would pass just as well against a schema that had quietly started accepting
  // 'null', and would prove nothing.
  it('the schema does reject a junk postId (positive control)', () => {
    expect(imagesQueryParamSchema.safeParse({ postId: 'null' }).success).toBe(false);
    expect(imagesQueryParamSchema.safeParse({ postId: 'abc' }).success).toBe(false);
  });

  it('does not throw on the exact query the old notification links carry', () => {
    // On revert to `.parse`, this throws ZodError naming
    // "'null' cannot be converted to a number" — legible, not a hang.
    expect(() => parseImageQueryParams({ imageId: '140935761', postId: 'null' })).not.toThrow();
    expect(parseImageQueryParams({ imageId: '140935761', postId: 'null' })).toEqual({});
  });

  it('still reads a valid query normally', () => {
    expect(parseImageQueryParams({ postId: '9876' })).toMatchObject({ postId: 9876 });
  });

  // The `{}` above is over-determined: `imageId` is not a schema key and `postId` was
  // the only other one, so `{}` is also what a "strip just the bad key" implementation
  // would return. This case separates them. Zod object parsing is all-or-nothing, so
  // the valid neighbours go too — assert that plainly rather than leaving a later
  // refactor free to change it and stay green.
  it('discards the whole filter object, not just the offending key', () => {
    expect(
      parseImageQueryParams({ postId: 'null', sort: 'Most Reactions', period: 'Week' })
    ).toEqual({});
  });
});
