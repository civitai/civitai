import { describe, it, expect, vi } from 'vitest';

// `cf-images-utils` reads `env.NEXT_PUBLIC_IMAGE_LOCATION` at call time. Stub the
// client env module before importing the unit under test so we don't trip the
// zod schema check in `~/env/client`.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test',
  },
}));

// `useEdgeUrl` is the REAL render path and the thing the monitor must agree with. With
// `useCurrentUser` stubbed it is a pure function, exercisable from the node suite.
const viewer = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => viewer.current }));
vi.mock('~/providers/BrowserSettingsProvider', () => ({ useBrowsingSettings: () => false }));
// Imported under a non-`use` alias on purpose: it is a hook only by naming convention
// (its only hook calls resolve through `useCurrentUser`, stubbed above), and the rules-of-hooks
// lint would otherwise reject calling it inside the width-ladder loop below.
import { getEdgeUrl, useEdgeUrl as resolveRenderedUrl } from '~/client-utils/cf-images-utils';
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
    // 200 snaps up the common-size ladder to 320; `optimized` comes from the call site.
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

  it('matches the variant the render path produces, flag and all', () => {
    // If the helper and the render path disagree, `announcement-media-check` probes a URL nobody
    // loads and calls a 404ing banner healthy.
    const rendered = resolveRenderedUrl(KEY, {
      width: ANNOUNCEMENT_IMAGE_WIDTH,
      optimized: true,
    });
    expect(rendered.url).toContain('optimized=true');
    expect(getAnnouncementImageUrl(KEY)).toBe(rendered.url);
  });

  it('equals the URL the render path actually produces, not a hand-rolled mirror', () => {
    // Pins the helper against `useEdgeUrl`'s real output: the width ladder, the 1800 cap, the
    // type/extension inference and the param order. That the CARD passes `optimized` is a separate
    // fact a node test cannot see — `AnnouncementCard.browser.test.tsx` covers that half.
    const rendered = resolveRenderedUrl(KEY, {
      width: ANNOUNCEMENT_IMAGE_WIDTH,
      optimized: true,
    });
    expect(getAnnouncementImageUrl(KEY)).toBe(rendered.url);
  });

  it('tracks the render path across the whole width ladder, not just the current width', () => {
    // Generalises the binding across the ladder, so an edit to ANNOUNCEMENT_IMAGE_WIDTH is covered
    // too.
    for (const width of [96, 200, 320, 450, 451, 512, 800, 2400]) {
      const expected = resolveRenderedUrl(KEY, { width, optimized: true }).url;
      const actual = getEdgeUrl(KEY, { width, optimized: true });
      expect(actual, `width=${width}`).toBe(expected);
    }
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
