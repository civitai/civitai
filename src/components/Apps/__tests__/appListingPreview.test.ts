import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  getListingPreview,
  getPreviewPosterUrl,
  LISTING_PREVIEW_SANDBOX,
  shouldMountPreviewIframe,
} from '~/components/Apps/appListingPreview';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * In-page live-preview view-model — node `unit` project: the fast,
 * deterministic suite CI runs on every PR (the browser `component` suites are
 * not run in CI at all).
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
          kindData: {
            kind: 'onsite',
            appBlockId: 'ab_1',
            hasPage: true,
            liveUrl: 'http://x.example',
          },
        })
      )
    ).toBeNull();
  });

  it('a javascript: liveUrl → NOT previewable', () => {
    expect(
      getListingPreview(
        detail({
          // eslint-disable-next-line no-script-url
          kindData: {
            kind: 'onsite',
            appBlockId: 'ab_1',
            hasPage: true,
            liveUrl: 'javascript:alert(1)',
          },
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
    expect(
      getListingPreview(
        detail({
          kindData: {
            kind: 'onsite',
            appBlockId: 'ab_1',
            hasPage: false,
            liveUrl: 'https://my-app.civit.ai',
          },
        })
      )
    ).not.toBeNull();
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

  /**
   * 🔴 THE CONSTANT BEING RIGHT IS NOT THE SAME AS THE FRAME BEING SANDBOXED.
   *
   * The assertion above compares a string to a literal; it stays green if
   * somebody deletes `sandbox={LISTING_PREVIEW_SANDBOX}` from the `<iframe>`
   * altogether — which would hand a third-party block an UNSANDBOXED frame. The
   * only test that caught that lived in the browser (`component`) project, which
   * CI does not run at all — so on a PR nothing was watching it.
   *
   * So the check below reads the JSX itself, in the suite CI does run.
   * Structural, not behavioural, and
   * deliberately so: rendering `AppListingDetailBody` in the node project would
   * mean booting Mantine + next/link + tRPC for one attribute. The repo already
   * uses source-level unit gates for exactly this shape of invariant (see
   * `no-io-in-transaction` / `no-wholesale-module-mock`).
   */
  describe('the preview <iframe> actually CARRIES the hardening props', () => {
    const SOURCE = path.resolve(__dirname, '../AppListingDetailBody.tsx');
    // Comments are stripped first: the file's own prose discusses `<iframe>`
    // several times, and matching those would scope every assertion below to a
    // doc-comment instead of the element.
    const source = fs
      .readFileSync(SOURCE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');

    /** The one `<iframe …>` JSX element in the detail body, attributes only. */
    function iframeJsx(): string {
      const starts = [...source.matchAll(/<iframe\b/g)].map((m) => m.index as number);
      // More than one frame means this helper is reading the wrong element and
      // every assertion below is silently scoped to the first — fail loudly.
      expect(starts, 'expected exactly one <iframe> in AppListingDetailBody.tsx').toHaveLength(1);
      const end = source.indexOf('/>', starts[0]);
      expect(end, 'unterminated <iframe> JSX').toBeGreaterThan(starts[0]);
      return source.slice(starts[0], end);
    }

    it('🔴 sandbox={LISTING_PREVIEW_SANDBOX} is on the element (deleting it fails HERE)', () => {
      expect(iframeJsx()).toMatch(/\bsandbox=\{LISTING_PREVIEW_SANDBOX\}/);
    });

    it('the sandbox value comes from the shared constant, never an inline literal', () => {
      // An inline `sandbox="allow-scripts allow-same-origin …"` would drift from
      // the constant the test above pins, so the two would stop agreeing.
      expect(iframeJsx()).not.toMatch(/\bsandbox="/);
    });

    it('referrerPolicy="no-referrer" is on the element', () => {
      expect(iframeJsx()).toMatch(/\breferrerPolicy="no-referrer"/);
    });

    it('the src is the https-guarded preview url, not the raw kindData value', () => {
      expect(iframeJsx()).toMatch(/\bsrc=\{preview\.liveUrl\}/);
      expect(iframeJsx()).not.toMatch(/\bsrc=\{[^}]*kindData/);
    });

    it('the frame is lazily loaded and titled for assistive tech', () => {
      expect(iframeJsx()).toMatch(/\bloading="lazy"/);
      expect(iframeJsx()).toMatch(/\btitle=\{preview\.frameTitle\}/);
    });
  });
});
