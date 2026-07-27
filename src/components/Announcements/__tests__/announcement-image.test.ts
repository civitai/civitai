import { describe, it, expect, vi } from 'vitest';

// `cf-images-utils` reads `env.NEXT_PUBLIC_IMAGE_LOCATION` at call time. Stub the
// client env module before importing the unit under test so we don't trip the
// zod schema check in `~/env/client`.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test',
  },
}));

// `useEdgeUrl` is the REAL render path and the thing the monitor must agree with. It is
// a hook only in the sense that it calls `useCurrentUser()`; with that stubbed it is a
// pure function, so it can be exercised directly from the node suite. Stub it to a
// signed-out viewer — the default, and the one whose `filePreferences` cannot mask a
// threshold change by forcing `optimized` on independently.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/providers/BrowserSettingsProvider', () => ({ useBrowsingSettings: () => false }));

// Imported under a non-`use` alias on purpose: it is a hook only by naming convention
// (its single hook call, `useCurrentUser`, is stubbed above), and the rules-of-hooks
// lint would otherwise reject calling it inside the width-ladder loop below.
import { getEdgeUrl, useEdgeUrl as resolveRenderedUrl } from '~/client-utils/cf-images-utils';
import { OPTIMIZED_WIDTH_THRESHOLD, shouldForceOptimized } from '~/client-utils/edge-url';
import {
  ANNOUNCEMENT_IMAGE_WIDTH,
  announcementImageFormSchema,
  getAnnouncementImageUrl,
  toAnnouncementImageFormValue,
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
    // The helper derives `optimized` from the same predicate the render path uses, so a
    // threshold change can no longer desync them — but a width above the threshold would
    // still change which variant users load, so pin the relationship explicitly.
    expect(ANNOUNCEMENT_IMAGE_WIDTH).toBeLessThanOrEqual(OPTIMIZED_WIDTH_THRESHOLD);
    expect(shouldForceOptimized(ANNOUNCEMENT_IMAGE_WIDTH)).toBe(true);
  });

  it('equals the URL the render path actually produces, not a hand-rolled mirror', () => {
    // 🔴 The binding test. `Announcement.tsx` renders
    // `<EdgeMedia src={key} width={ANNOUNCEMENT_IMAGE_WIDTH} />`, and EdgeMedia resolves
    // its src through `useEdgeUrl`. Compare against that function's real output rather
    // than against `getEdgeUrl(..., { optimized: true })`, which would re-assert the
    // helper's own assumption. Fails if the optimized threshold, the width ladder, the
    // 1800 cap, the type/extension inference or the param order ever change under it —
    // any of which would make the monitor probe a variant nobody loads and then emit a
    // false `announcement-image-render-failed` on a healthy banner.
    const rendered = resolveRenderedUrl(KEY, { width: ANNOUNCEMENT_IMAGE_WIDTH });
    expect(getAnnouncementImageUrl(KEY)).toBe(rendered.url);
  });

  it('tracks the render path across the whole width ladder, not just the current width', () => {
    // Generalises the binding: for any width the banner could plausibly be given, the
    // helper's construction and the render path agree. Guards a future edit to
    // ANNOUNCEMENT_IMAGE_WIDTH as well as to the ladder/threshold.
    for (const width of [96, 200, 320, 450, 451, 512, 800, 2400]) {
      const expected = resolveRenderedUrl(KEY, { width }).url;
      const actual = getEdgeUrl(KEY, {
        width,
        optimized: shouldForceOptimized(width) ? true : undefined,
      });
      expect(actual, `width=${width}`).toBe(expected);
    }
  });

  it('drops the optimized flag entirely above the threshold (never optimized=false)', () => {
    const wide = OPTIMIZED_WIDTH_THRESHOLD + 1;
    expect(shouldForceOptimized(wide)).toBe(false);
    expect(resolveRenderedUrl(KEY, { width: wide }).url).not.toContain('optimized');
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

  describe('wire-format round-trip through the modal form', () => {
    // The highest-stakes behaviour: editing a live announcement and saving it unchanged
    // must not rewrite `metadata.image`. Mirrors what the modal does — read the stored
    // metadata into `defaultValues.image`, let the form schema validate it, normalise on
    // submit — without booting the modal itself.
    const submit = (formValue: unknown) =>
      toAnnouncementImageKey(announcementImageFormSchema.parse(formValue));

    it('load -> save unchanged is byte-identical for a stored bare key', () => {
      const stored = { image: KEY, colSpan: 6 };
      const loaded = toAnnouncementImageFormValue(stored);
      expect(loaded).toBe(KEY);
      expect(submit(loaded)).toBe(KEY);
      // Byte-identical, not merely equal: same string, no re-encoding or trimming.
      expect(submit(loaded)).toStrictEqual(stored.image);
    });

    it('a fresh upload persists the uploaded key, not the widget object', () => {
      // The widget hands the form a DataFromFile-shaped object on success.
      const uploaded = { url: KEY, objectUrl: 'blob:http://localhost/abc', id: KEY, type: 'image' };
      expect(submit(uploaded)).toBe(KEY);
    });

    it('replacing an existing banner persists the NEW key', () => {
      const replacement = 'ffffffff-1111-2222-3333-444444444444';
      const loaded = toAnnouncementImageFormValue({ image: KEY });
      expect(submit(loaded)).toBe(KEY);
      expect(submit({ url: replacement })).toBe(replacement);
    });

    it('clearing drops the key entirely rather than persisting null or an empty string', () => {
      // `announcementMetaSchema.image` is `z.string().optional()`. `null` fails that
      // schema outright, and `""` would persist a key that resolves to a broken URL —
      // the metadata field must simply be absent.
      expect(submit(null)).toBeUndefined();
      expect(submit(undefined)).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call({ image: submit(null) }, 'image')).toBe(true);
      expect(JSON.stringify({ image: submit(null) })).toBe('{}');
    });

    it('loads no value from an announcement that never had a banner', () => {
      expect(toAnnouncementImageFormValue(undefined)).toBeUndefined();
      expect(toAnnouncementImageFormValue(null)).toBeUndefined();
      expect(toAnnouncementImageFormValue({})).toBeUndefined();
      expect(submit(toAnnouncementImageFormValue({}))).toBeUndefined();
    });
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
