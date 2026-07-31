import { describe, expect, it } from 'vitest';
import {
  getListingPreview,
  getPreviewPosterUrl,
  LISTING_PREVIEW_SANDBOX,
  shouldMountPreviewIframe,
} from '~/components/Apps/appListingPreview';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * In-page live-preview view-model — node `unit` project (the BLOCKING gate).
 *
 * The load-bearing assertion is `shouldMountPreviewIframe` being FALSE before
 * activation: that is the whole poster-first design, and a regression there
 * (mounting on load) is invisible in a screenshot but makes every listing view
 * boot a third-party app frame.
 */

function detail(over: Partial<ListingDetail> = {}): ListingDetail {
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    name: 'My App',
    tagline: null,
    description: null,
    category: null,
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    screenshots: [],
    kindData: {
      kind: 'onsite',
      appBlockId: 'ab_1',
      hasPage: true,
      liveUrl: 'https://my-app.civit.ai',
    },
    ...over,
  };
}

describe('getListingPreview', () => {
  it('on-site with an https liveUrl → previewable', () => {
    const preview = getListingPreview(detail());
    expect(preview).toEqual({
      liveUrl: 'https://my-app.civit.ai',
      posterUrl: null,
      frameTitle: 'My App live preview',
    });
  });

  it('re-guards a non-https liveUrl → NOT previewable (never becomes an iframe src)', () => {
    expect(
      getListingPreview(
        detail({
          kindData: { kind: 'onsite', appBlockId: 'ab_1', hasPage: true, liveUrl: 'http://x.example' },
        })
      )
    ).toBeNull();
  });

  it('a javascript: liveUrl → NOT previewable', () => {
    expect(
      getListingPreview(
        detail({
          // eslint-disable-next-line no-script-url
          kindData: { kind: 'onsite', appBlockId: 'ab_1', hasPage: true, liveUrl: 'javascript:alert(1)' },
        })
      )
    ).toBeNull();
  });

  it('OFF-SITE listings are never previewed (we neither host nor control that site)', () => {
    expect(
      getListingPreview(
        detail({
          kind: 'offsite',
          kindData: {
            kind: 'offsite',
            subKind: 'external-link',
            externalUrl: 'https://ext.app',
            connectClientId: null,
          },
        })
      )
    ).toBeNull();
  });

  it('a model-slot on-site app is STILL previewable (its standalone origin is live)', () => {
    // hasPage governs the /apps/run route, not whether <slug>.civit.ai exists —
    // the deploy-gate already guarantees the origin for any listed on-site app.
    expect(getListingPreview(detail({
      kindData: { kind: 'onsite', appBlockId: 'ab_1', hasPage: false, liveUrl: 'https://my-app.civit.ai' },
    }))).not.toBeNull();
  });
});

describe('getPreviewPosterUrl', () => {
  it('prefers the cover', () => {
    expect(
      getPreviewPosterUrl(
        detail({
          coverUrl: 'https://cdn.example/cover.png',
          screenshots: [{ url: 'https://cdn.example/shot.png', caption: null }],
        })
      )
    ).toBe('https://cdn.example/cover.png');
  });

  it('falls back to the first screenshot', () => {
    expect(
      getPreviewPosterUrl(
        detail({ screenshots: [{ url: 'https://cdn.example/shot.png', caption: null }] })
      )
    ).toBe('https://cdn.example/shot.png');
  });

  it('skips a screenshot with an empty url', () => {
    expect(
      getPreviewPosterUrl(
        detail({
          screenshots: [
            { url: '', caption: null },
            { url: 'https://cdn.example/second.png', caption: null },
          ],
        })
      )
    ).toBe('https://cdn.example/second.png');
  });

  it('NO poster available → null (the caller still renders an activatable placeholder)', () => {
    expect(getPreviewPosterUrl(detail())).toBeNull();
  });
});

describe('shouldMountPreviewIframe — poster-first contract', () => {
  const preview = getListingPreview(detail());

  it('🔴 does NOT mount before activation (no iframe boots on page load)', () => {
    expect(shouldMountPreviewIframe({ preview, activated: false })).toBe(false);
  });

  it('mounts after activation', () => {
    expect(shouldMountPreviewIframe({ preview, activated: true })).toBe(true);
  });

  it('never mounts when there is nothing to preview, even if "activated"', () => {
    expect(shouldMountPreviewIframe({ preview: null, activated: true })).toBe(false);
  });
});

describe('sandbox parity with the legacy preview', () => {
  it('keeps allow-scripts + allow-same-origin together and nothing else', () => {
    // Parity with `/apps/[appBlockId]`. allow-same-origin gives the frame ITS
    // OWN origin (<slug>.civit.ai), not civitai.com's. Widening this list is a
    // deliberate act, so it is pinned.
    expect(LISTING_PREVIEW_SANDBOX.split(' ').sort()).toEqual([
      'allow-same-origin',
      'allow-scripts',
    ]);
  });
});
