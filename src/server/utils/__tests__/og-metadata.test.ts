import { describe, expect, it } from 'vitest';

import { extractListingMeta } from '~/server/utils/og-metadata';

/**
 * PURE OG/HTML metadata extraction — og:title/description/image + favicon/
 * apple-touch-icon + <title>, relative-URL resolution, and the missing-tags →
 * empty-object graceful case.
 */

const BASE = 'https://vendor.example.com/apps/cool';

describe('extractListingMeta', () => {
  it('pulls og:title / og:description / og:image + apple-touch-icon (absolute)', () => {
    const html = `
      <head>
        <meta property="og:title" content="Cool App" />
        <meta property="og:description" content="Does cool things" />
        <meta property="og:image" content="https://cdn.example.com/og.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="https://cdn.example.com/touch.png" />
      </head>`;
    // og:description feeds BOTH the short tagline and the longer Description body.
    expect(extractListingMeta(html, BASE)).toEqual({
      name: 'Cool App',
      tagline: 'Does cool things',
      description: 'Does cool things',
      coverImageUrl: 'https://cdn.example.com/og.png',
      iconImageUrl: 'https://cdn.example.com/touch.png',
    });
  });

  it('suggests a Description from og:description, clamped to the description bound (2000)', () => {
    const long = 'y'.repeat(2500);
    const r = extractListingMeta(`<meta property="og:description" content="${long}">`, BASE);
    // Tagline clamps tight (140); description clamps to the longer body bound (2000).
    expect(r.tagline?.length).toBe(140);
    expect(r.description?.length).toBe(2000);
  });

  it('resolves RELATIVE asset URLs against the final page URL', () => {
    const html = `
      <meta property="og:image" content="/img/og.jpg">
      <link rel="icon" href="favicon.ico">`;
    const r = extractListingMeta(html, BASE);
    expect(r.coverImageUrl).toBe('https://vendor.example.com/img/og.jpg');
    // Relative to the page path (…/apps/cool) → …/apps/favicon.ico
    expect(r.iconImageUrl).toBe('https://vendor.example.com/apps/favicon.ico');
  });

  it('falls back to <title> for the name and meta[name=description] for the tagline', () => {
    const html = `<title>  Plain &amp; Simple  </title>
      <meta name="description" content="Fallback &quot;desc&quot;">`;
    const r = extractListingMeta(html, BASE);
    expect(r.name).toBe('Plain & Simple');
    expect(r.tagline).toBe('Fallback "desc"');
  });

  it('prefers apple-touch-icon, else the largest declared rel=icon', () => {
    const html = `
      <link rel="icon" sizes="16x16" href="/small.png">
      <link rel="icon" sizes="64x64" href="/big.png">`;
    expect(extractListingMeta(html, BASE).iconImageUrl).toBe('https://vendor.example.com/big.png');
  });

  it('uses twitter:image as a cover fallback when og:image is absent', () => {
    const html = `<meta name="twitter:image" content="https://cdn.example.com/tw.png">`;
    expect(extractListingMeta(html, BASE).coverImageUrl).toBe('https://cdn.example.com/tw.png');
  });

  it('returns {} for a page with no usable tags (graceful fallback)', () => {
    expect(extractListingMeta('<html><body><p>hi</p></body></html>', BASE)).toEqual({});
    expect(extractListingMeta('', BASE)).toEqual({});
  });

  it('drops a data: URI image (non-fetchable) rather than suggesting it', () => {
    const html = `<meta property="og:image" content="data:image/png;base64,AAAA">`;
    expect(extractListingMeta(html, BASE).coverImageUrl).toBeUndefined();
  });

  it('drops a non-https (http:) suggested image/icon so the preview matches the https-only accept path', () => {
    const html = `
      <meta property="og:image" content="http://cdn.example.com/og.png">
      <link rel="apple-touch-icon" href="http://cdn.example.com/touch.png">`;
    const r = extractListingMeta(html, BASE);
    expect(r.coverImageUrl).toBeUndefined();
    expect(r.iconImageUrl).toBeUndefined();
  });

  it('keeps a protocol-relative asset (//host/x) since it resolves to https against an https page', () => {
    const html = `<meta property="og:image" content="//cdn.example.com/og.png">`;
    expect(extractListingMeta(html, BASE).coverImageUrl).toBe('https://cdn.example.com/og.png');
  });

  it('clamps an over-long name to the listing name bound', () => {
    const long = 'x'.repeat(300);
    const r = extractListingMeta(`<meta property="og:title" content="${long}">`, BASE);
    expect(r.name?.length).toBe(120);
  });

  describe('header/nav <img> icon fallback', () => {
    it('falls back to the first <img> inside <header> when no favicon resolves', () => {
      const html = `
        <header><a href="/"><img src="/brand/logo.svg" alt="Acme" width="120" height="40"></a></header>
        <main><img src="/hero.png"></main>`;
      const r = extractListingMeta(html, BASE);
      expect(r.iconImageUrl).toBe('https://vendor.example.com/brand/logo.svg');
    });

    it('falls back to a <nav> logo image', () => {
      const html = `<nav><img src="https://cdn.example.com/nav-logo.png"></nav>`;
      expect(extractListingMeta(html, BASE).iconImageUrl).toBe('https://cdn.example.com/nav-logo.png');
    });

    it('falls back to an <img class="logo"> anywhere when there is no header/nav', () => {
      const html = `<div><img class="site-logo" src="/logo.png"></div>`;
      expect(extractListingMeta(html, BASE).iconImageUrl).toBe('https://vendor.example.com/logo.png');
    });

    it('PREFERS a real favicon over the header image (fallback only kicks in with no icon)', () => {
      const html = `
        <link rel="icon" href="/favicon.png">
        <header><img src="/brand/logo.png"></header>`;
      // The declared favicon wins — the header <img> is a last resort only.
      expect(extractListingMeta(html, BASE).iconImageUrl).toBe('https://vendor.example.com/favicon.png');
    });

    it('skips a tiny tracking pixel / sprite (declared ≤32px) in the header', () => {
      const html = `
        <header>
          <img src="/pixel.gif" width="1" height="1">
          <img src="/real-logo.png" width="140" height="48">
        </header>`;
      expect(extractListingMeta(html, BASE).iconImageUrl).toBe('https://vendor.example.com/real-logo.png');
    });

    it('skips a data: URI header image and a header <img> with no src', () => {
      const html = `
        <header><img alt="spacer"><img src="data:image/gif;base64,AAAA"></header>`;
      expect(extractListingMeta(html, BASE).iconImageUrl).toBeUndefined();
    });

    it('drops a non-https header image (matches the https-only accept path)', () => {
      const html = `<header><img src="http://cdn.example.com/logo.png"></header>`;
      expect(extractListingMeta(html, BASE).iconImageUrl).toBeUndefined();
    });
  });

  describe('inline data-URI icon channel (iconDataUri)', () => {
    it('surfaces a data:image/svg+xml favicon as iconDataUri (radio.civitai.com case) — name set, cover/description undefined', () => {
      // radio.civitai.com's <head>: only a <title> + an inline SVG favicon. No og:image,
      // no description. The https icon channel drops the data: URI; the inline channel
      // surfaces it so the author still gets an accept-able icon.
      const svg = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
      const html = `<title>AI Radio</title><link rel="icon" type="image/svg+xml" href="${svg}">`;
      const r = extractListingMeta(html, BASE);
      expect(r.name).toBe('AI Radio');
      expect(r.iconDataUri).toBe(svg);
      // No usable https icon, no cover, no description — genuinely absent.
      expect(r.iconImageUrl).toBeUndefined();
      expect(r.coverImageUrl).toBeUndefined();
      expect(r.description).toBeUndefined();
      expect(r.tagline).toBeUndefined();
    });

    it('surfaces a base64 data:image/png apple-touch-icon as iconDataUri', () => {
      const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
      const html = `<link rel="apple-touch-icon" href="${dataUri}">`;
      expect(extractListingMeta(html, BASE).iconDataUri).toBe(dataUri);
    });

    it('does NOT surface a data:text/html icon as iconDataUri (non-image rejected)', () => {
      const html = `<link rel="icon" href="data:text/html,%3Cscript%3Ealert(1)%3C%2Fscript%3E">`;
      const r = extractListingMeta(html, BASE);
      expect(r.iconDataUri).toBeUndefined();
      expect(r.iconImageUrl).toBeUndefined();
    });

    it('prefers a real https favicon for iconImageUrl but STILL surfaces an inline data-URI icon separately', () => {
      const dataUri = 'data:image/svg+xml,%3Csvg%2F%3E';
      const html = `
        <link rel="icon" href="/favicon.png">
        <link rel="apple-touch-icon" href="${dataUri}">`;
      const r = extractListingMeta(html, BASE);
      // The https favicon is NOT shadowed by the data-URI apple-touch-icon.
      expect(r.iconImageUrl).toBe('https://vendor.example.com/favicon.png');
      expect(r.iconDataUri).toBe(dataUri);
    });

    it('a normal page with no data-URI icon leaves iconDataUri undefined (https icon still works)', () => {
      const html = `<link rel="icon" href="/favicon.ico">`;
      const r = extractListingMeta(html, BASE);
      expect(r.iconImageUrl).toBe('https://vendor.example.com/favicon.ico');
      expect(r.iconDataUri).toBeUndefined();
    });
  });

  describe('adversarial-input cost (event-loop-freeze / ReDoS guard)', () => {
    // Regression for the O(n^2) container-regex freeze: many unclosed <header>
    // open tags forced the lazy backreference match to rescan to EOF at every
    // start position. A ~1.5MB body froze the event loop ~45s. The parse cap +
    // bounded lazy quantifier make it linear-with-small-constant. Threshold is
    // generous (CI variance) but still ~10x under the broken time.
    it('parses a 1.5MB run of unclosed <header> tags in bounded time', () => {
      const html = '<header>'.repeat(200_000); // ~1.6MB, no closer, no <link icon>
      const t0 = Date.now();
      const r = extractListingMeta(html, BASE);
      const elapsed = Date.now() - t0;
      expect(r.iconImageUrl).toBeUndefined(); // nothing extractable, but no hang
      expect(elapsed).toBeLessThan(4000);
    });

    it('parses a 1.5MB run of mismatched header/nav tags in bounded time', () => {
      const html = '<header>x</nav>'.repeat(120_000); // backref never satisfied
      const t0 = Date.now();
      extractListingMeta(html, BASE);
      expect(Date.now() - t0).toBeLessThan(4000);
    });
  });
});
