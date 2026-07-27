import { describe, it, expect, vi } from 'vitest';

// `cf-images-utils` reads `env.NEXT_PUBLIC_IMAGE_LOCATION` at call time. Stub the
// client env module before importing the unit under test so we don't trip the
// zod schema check in `~/env/client`.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test',
  },
}));

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  ANNOUNCEMENT_IMAGE_WIDTH,
  announcementImageFormSchema,
  getAnnouncementImageUrl,
  toAnnouncementImageKey,
} from '~/components/Announcements/announcement-image';

const KEY = '7171bdc6-8007-492c-84ad-f607e4dbd320';

describe('getAnnouncementImageUrl', () => {
  it('reproduces the variant the banner actually renders', () => {
    // 200 snaps up the common-size ladder to 320, and widths <= 450 force optimized.
    expect(getAnnouncementImageUrl(KEY)).toBe(
      `https://image.test/${KEY}/width=320,optimized=true/${KEY}.jpeg`
    );
  });

  it('matches what getEdgeUrl produces for the rendered width', () => {
    expect(getAnnouncementImageUrl(KEY)).toBe(
      getEdgeUrl(KEY, { width: ANNOUNCEMENT_IMAGE_WIDTH, optimized: true })
    );
  });

  it('snaps the render width up to 320 rather than emitting it verbatim', () => {
    const url = getAnnouncementImageUrl(KEY);
    expect(url).toContain('width=320');
    expect(url).not.toContain(`width=${ANNOUNCEMENT_IMAGE_WIDTH}`);
  });

  it('is NOT the original variant', () => {
    // The original object and the derived variant are different derivation paths —
    // checking `original=true` is what let a broken banner go unnoticed.
    expect(getAnnouncementImageUrl(KEY)).not.toContain('original=true');
    expect(getAnnouncementImageUrl(KEY)).not.toBe(getEdgeUrl(KEY, { original: true }));
  });

  it('keeps the render width inside the range that forces optimized', () => {
    // useEdgeUrl forces optimized for widths <= 450; if the banner width ever grows past
    // that, this helper's hardcoded `optimized: true` would stop matching the render.
    expect(ANNOUNCEMENT_IMAGE_WIDTH).toBeLessThanOrEqual(450);
  });
});

describe('announcement image form value <-> wire format', () => {
  it('passes a stored bare key through byte-identically', () => {
    expect(toAnnouncementImageKey(KEY)).toBe(KEY);
  });

  it('reduces an upload-widget object to its bare key', () => {
    expect(toAnnouncementImageKey({ url: KEY, id: 5, nsfwLevel: 1 } as never)).toBe(KEY);
  });

  it('emits undefined (never null) when the image is cleared', () => {
    // `announcementMetaSchema.image` is `z.string().optional()` — null would not validate.
    expect(toAnnouncementImageKey(null)).toBeUndefined();
    expect(toAnnouncementImageKey(undefined)).toBeUndefined();
  });

  it('preserves the empty string rather than silently changing the stored shape', () => {
    expect(toAnnouncementImageKey('')).toBe('');
  });

  it('accepts both the stored string and the upload object in form state', () => {
    expect(announcementImageFormSchema.parse(KEY)).toBe(KEY);
    expect(announcementImageFormSchema.parse({ url: KEY })).toMatchObject({ url: KEY });
    expect(announcementImageFormSchema.parse(null)).toBeNull();
    expect(announcementImageFormSchema.parse(undefined)).toBeUndefined();
  });

  it('round-trips form state back to the exact wire format the renderer reads', () => {
    const fromUpload = announcementImageFormSchema.parse({ url: KEY, extra: true });
    const fromEdit = announcementImageFormSchema.parse(KEY);
    expect(toAnnouncementImageKey(fromUpload)).toBe(KEY);
    expect(toAnnouncementImageKey(fromEdit)).toBe(KEY);
    // Both paths persist an identical bare key — no announcement's metadata changes shape.
    expect(toAnnouncementImageKey(fromUpload)).toBe(toAnnouncementImageKey(fromEdit));
  });
});
