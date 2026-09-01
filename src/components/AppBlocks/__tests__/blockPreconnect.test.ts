import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { blockPreconnectHint, blockPreconnectOrigin } from '../blockPreconnect';

/**
 * App Blocks — the SSR `preconnect` hint for the block origin.
 *
 * 🔴 THIS TESTS AN ELEMENT, NOT A RENDER, ON PURPOSE. The hint is emitted into
 * `next/head`, and `next/head` renders nothing into a DOM — it hands its
 * children to a head manager. Asserting on the returned React element's props
 * is therefore MORE direct than rendering, not less: it reads exactly the
 * attributes the browser will see, and it runs in the `unit` project, which is
 * the tier CI actually executes (the `component` project is not run in CI).
 *
 * The three properties that make the hint work, all of which fail SILENTLY:
 *   - `rel="preconnect"` — a typo'd rel is simply ignored by the browser;
 *   - the ORIGIN, derived from `iframeSrc` — a hint for the wrong host warms a
 *     connection nobody uses and the page just stays slow;
 *   - `crossorigin` — without it the browser warms the CREDENTIALLED connection
 *     pool while the frame's module scripts fetch from the ANONYMOUS one, so
 *     the hint costs a connection and saves nothing. No error, no warning.
 */
describe('blockPreconnectOrigin', () => {
  it('derives the origin from a normal block iframe src', () => {
    expect(blockPreconnectOrigin('https://sensei.civit.ai/')).toBe('https://sensei.civit.ai');
  });

  it('drops the path, query and fragment — an origin is scheme + host + port', () => {
    // The real `iframeSrc` carries an init fragment on some surfaces, and a
    // sub-path on the `[[...path]]` route. `preconnect` takes an ORIGIN; a href
    // carrying a path still works but stops being obviously correct, and a
    // fragment would make two identical origins look like two different hints.
    expect(blockPreconnectOrigin('https://sensei.civit.ai/deep/path?x=1#civitai-block=v1')).toBe(
      'https://sensei.civit.ai'
    );
  });

  it('preserves a non-default port (dev tunnels and preview hosts)', () => {
    expect(blockPreconnectOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
  });

  it('returns null for a relative, empty, or malformed src rather than throwing', () => {
    // 🔴 `new URL()` THROWS on these, and this runs during SSR — an unhandled
    // TypeError here would 500 the whole run page for a missing OPTIMISATION.
    // The hint must stay strictly subordinate to what it accelerates.
    expect(blockPreconnectOrigin('/apps/run/sensei')).toBeNull();
    expect(blockPreconnectOrigin('not a url')).toBeNull();
    expect(blockPreconnectOrigin('')).toBeNull();
    expect(blockPreconnectOrigin(null)).toBeNull();
    expect(blockPreconnectOrigin(undefined)).toBeNull();
  });

  it('refuses a non-http(s) scheme', () => {
    // `new URL('javascript:alert(1)')` parses fine and yields origin "null".
    // Emitting `<link href="null">` would be junk in the head; emitting the raw
    // scheme would be worse.
    expect(blockPreconnectOrigin('javascript:alert(1)')).toBeNull();
    expect(blockPreconnectOrigin('data:text/html,hi')).toBeNull();
  });
});

describe('blockPreconnectHint', () => {
  it('renders a <link rel="preconnect"> at the derived origin', () => {
    const el = blockPreconnectHint('https://sensei.civit.ai/some/path');
    expect(el).not.toBeNull();
    expect(el?.type).toBe('link');
    expect(el?.props.rel).toBe('preconnect');
    expect(el?.props.href).toBe('https://sensei.civit.ai');
  });

  /**
   * 🔴 THE ASSERTION THIS FILE EXISTS FOR.
   *
   * A connection is pooled by (origin, credentials-mode). The block frame's own
   * subresources are `<script type="module" crossorigin>` — CORS requests, so
   * the ANONYMOUS pool. A preconnect without `crossorigin` opens a
   * CREDENTIALLED connection that is never reused: the page pays for a socket
   * AND still pays the handshake it meant to skip.
   *
   * Nothing observable fails when this is wrong. The page renders, the tests
   * pass, the hint is visibly present in the HTML, and the optimisation is
   * simply absent. That is exactly the class of defect a test has to carry.
   */
  it('🔴 sets crossorigin — without it the hint warms the wrong connection pool and is inert', () => {
    const el = blockPreconnectHint('https://sensei.civit.ai/');
    expect(el?.props.crossOrigin).toBe('anonymous');
  });

  it('returns null (renders nothing) when the origin cannot be derived', () => {
    expect(blockPreconnectHint('/relative')).toBeNull();
    expect(blockPreconnectHint(undefined)).toBeNull();
  });
});

/**
 * 🔴 PLACEMENT IS HALF THE FEATURE, AND IT IS NOT VISIBLE IN THE ELEMENT.
 *
 * `blockPreconnectHint()` returns a correct `<link>` wherever it is called. The
 * VALUE comes entirely from being emitted in the SSR document head: the iframe
 * mounts on the first client render AFTER hydration, so a hint emitted from the
 * host component fires at the same moment the browser would have connected
 * anyway. Move the call into `PageBlockHost` and every assertion above stays
 * green while the feature becomes a no-op.
 *
 * A source gate is a weaker instrument than a behavioural test and is named as
 * such — it checks the SHAPE of the call site, so a refactor preserving neither
 * defeats it. It is used here for the same reason `launchSampleBound.test.ts`
 * uses one for the launch-mark seed: the behavioural alternative can only live
 * in the `component` project, which CI does not run, so it would report safety
 * from a tier nothing observes.
 */
describe('the hint is emitted from the run page SSR head', () => {
  const PAGE = path.resolve(__dirname, '../../../pages/apps/run/[slug]/[[...path]].tsx');
  const HOST = path.resolve(__dirname, '../PageBlockHost.tsx');

  /** Character ranges of every `<Head>…</Head>` region in a source file. */
  function headSpans(src: string): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    let from = 0;
    for (;;) {
      const open = src.indexOf('<Head>', from);
      if (open === -1) break;
      const close = src.indexOf('</Head>', open);
      if (close === -1) break;
      spans.push([open, close]);
      from = close + 1;
    }
    return spans;
  }

  function hintIsInsideHead(src: string): boolean {
    const call = src.indexOf('blockPreconnectHint(');
    if (call === -1) return false;
    return headSpans(src).some(([a, b]) => call > a && call < b);
  }

  /**
   * 🔴 POSITIVE + NEGATIVE CONTROL FOR THE CHECKER ITSELF. Without these, a
   * checker whose `indexOf` scan silently matched nothing would answer `false`
   * for every input — and the real assertion below would then be red for a
   * reason that has nothing to do with the page.
   */
  it('the checker distinguishes a call inside <Head> from one outside it', () => {
    expect(hintIsInsideHead('<Head>{blockPreconnectHint(src)}</Head>')).toBe(true);
    expect(hintIsInsideHead('<Head><title>x</title></Head>{blockPreconnectHint(src)}')).toBe(false);
    expect(hintIsInsideHead('{blockPreconnectHint(src)}')).toBe(false);
    expect(hintIsInsideHead('<Head><title>x</title></Head>')).toBe(false);
  });

  it('🔴 the run page calls blockPreconnectHint inside a <Head>', () => {
    const src = fs.readFileSync(PAGE, 'utf8');
    // Guard the guard: fail loudly on a rename rather than passing vacuously.
    expect(src).toContain('blockPreconnectHint');
    expect(hintIsInsideHead(src)).toBe(true);
  });

  it('🔴 the origin comes from the iframeSrc prop, not a re-derived slug+domain', () => {
    // A second source of truth for the block origin is how the hint ends up
    // warming a host the iframe never contacts — silently, since the page still
    // works. `stampCanonicalIframeSrc` owns that string server-side.
    const src = fs.readFileSync(PAGE, 'utf8');
    expect(src).toContain('blockPreconnectHint(iframeSrc)');
  });

  it('🔴 the host component does NOT emit it (that placement is inert)', () => {
    const src = fs.readFileSync(HOST, 'utf8');
    expect(src).not.toContain('blockPreconnectHint');
  });
});
