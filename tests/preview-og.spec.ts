import { expect, test } from '@playwright/test';

/**
 * HTTP-level regression guard for `/api/og` (Open Graph preview cards) against a
 * DEPLOYED, PRODUCTION-BUILT server. Runs under playwright.preview.config.ts —
 * the `preview-*.spec.ts` filename is what enrolls it in the `preview-smoke`
 * project, so this needs no pipeline change.
 *
 * WHY OVER HTTP AND NOT IN A UNIT TEST. `/api/og` has now broken twice, and both
 * times the defect lived in the built artifact / the running server rather than
 * in the card components:
 *
 *   1. `@vercel/og`'s dynamic require could not be traced under
 *      `output: 'standalone'`, so the module was dropped from the image
 *      (see `outputFileTracingIncludes['/api/og']` in next.config.mjs).
 *   2. Next's image optimizer applies a process-global libvips block the first
 *      time it initializes `sharp`, and the SVG loader `next/og` needs was not
 *      re-enabled — so every render threw once the optimizer had run.
 *
 * A test that renders the card component in-process is green through BOTH. This
 * one boots nothing itself; it exercises the real deployed server.
 *
 * 🔴 ORDER IS THE TEST. Case (2) only manifests AFTER the image optimizer has
 * initialized sharp, which happens on the first `/_next/image` cache MISS — up
 * to a minute into a pod's life. Request `/api/og` first and it passes on a
 * broken build. So the first test forces an optimizer cache miss and asserts
 * `x-nextjs-cache: MISS`, which is what stops the ordering step from silently
 * becoming a no-op (a cache HIT never calls `getSharp()`).
 *
 * HONEST LIMITS.
 *  - The ordering only holds when the warmup and the `/api/og` request reach the
 *    same process. A PR preview is a single replica (see the serial/worker notes
 *    in playwright.preview.config.ts), so it does; pointed at a multi-replica
 *    deployment the ordering degrades to "probably".
 *  - Previews are opt-in behind the `preview` label, and the smoke step is
 *    report-only, so this is a signal rather than a merge gate today.
 *
 * The in-process companion guard, which has neither limitation but also cannot
 * see packaging failures, is `src/tests/api/og.image-optimizer-sharp.test.ts`.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A small PNG that ships in `public/`, so the optimizer resolves it locally with
// no dependency on remote image hosts.
const LOCAL_IMAGE = '/images/logo_dark_mode.png';

const bust = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

function expectOgPng(body: Buffer, headers: Record<string, string>) {
  expect(headers['content-type'], 'content-type').toContain('image/png');
  expect(
    body.subarray(0, 8).equals(PNG_MAGIC),
    `PNG magic (got ${body.subarray(0, 8).toString('hex')})`
  ).toBe(true);
  // A 1200x630 card is tens of KB; under 1 KB means a truncated or blank encode.
  expect(body.byteLength, 'PNG byte length').toBeGreaterThan(1024);
}

// `w` is the only usable cache-buster. The optimizer key is (url, w, q); `q` must
// be one of `images.qualities` (default `[75]`), and a query string on a LOCAL
// `url` is a flat 400 because Next's default `localPatterns` requires an empty
// search (measured 2026-08-09: `/_next/image?url=%2Fx.png%3Fcb%3D1` → 400). So
// walk the configured widths — Next's default `imageSizes` then `deviceSizes` —
// until one is cold. Cheapest first; a fresh pod misses on the very first.
// A width the server rejects is skipped, not fatal, so re-tuning `images.*`
// narrows this list instead of breaking the test.
// (`16` is deliberately absent: this deployment answers 400 for it.)
const CANDIDATE_WIDTHS = [32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048];

// Serial: the warmup must run before the renders, and serial is the only thing
// that guarantees that independently of the config's `workers`/`fullyParallel`.
// A failure here correctly aborts the rest of the group — the ordering premise is
// gone, so their verdicts would be meaningless.
test.describe('render path (requires the optimizer to have run first)', () => {
  test.describe.configure({ mode: 'serial' });

  test('image optimizer initializes sharp (cache miss)', async ({ request }) => {
    const seen: string[] = [];
    let servedAnImage = false;
    let missed = false;

    for (const w of CANDIDATE_WIDTHS) {
      const resp = await request.get(
        `/_next/image?url=${encodeURIComponent(LOCAL_IMAGE)}&w=${w}&q=75`
      );
      if (resp.status() !== 200) {
        seen.push(`${w}:HTTP${resp.status()}`);
        continue;
      }
      expect(resp.headers()['content-type'], `optimizer content-type at w=${w}`).toMatch(
        /^image\//
      );
      servedAnImage = true;

      // The header's PRESENCE is what distinguishes "Next's image optimizer served
      // this" from "a static file server or CDN did" — and only the optimizer path
      // reaches `getSharp()`.
      const state = resp.headers()['x-nextjs-cache'];
      expect(state, `x-nextjs-cache at w=${w} (absent ⇒ the optimizer never ran)`).toBeDefined();
      seen.push(`${w}:${state}`);
      if (state === 'MISS') {
        missed = true;
        break;
      }
    }

    const tried = seen.join(', ');
    expect(servedAnImage, `the image optimizer served nothing at any width — tried ${tried}`).toBe(
      true
    );
    // A HIT is served straight from the cache WITHOUT calling `getSharp()` — and
    // that cache is on disk, so it outlives the process. A HIT is therefore not
    // evidence that sharp was initialized in the process now serving us, and
    // accepting one would make every assertion below vacuous. Demand a real MISS.
    //
    // Exhausting the list means the precondition genuinely could not be established
    // on this run — a red worth seeing rather than a green worth nothing. It cannot
    // happen on a freshly deployed preview pod (empty `.next/cache/images`); it does
    // happen when re-running against an already-warm server.
    expect(missed, `no cold optimizer width left to force a MISS — tried ${tried}`).toBe(true);
  });

  test('/api/og renders a PNG for a missing entity (FallbackCard path)', async ({ request }) => {
    // Deliberately DB-independent: no such model, so the handler renders the
    // generic card. No fixtures, no seeded ids, nothing to rot.
    const resp = await request.get(`/api/og?type=model&id=999999999&cb=${bust()}`);
    const body = await resp.body();

    expect(resp.status(), `status (body: ${body.subarray(0, 200).toString('utf8')})`).toBe(200);
    expectOgPng(body, resp.headers());
  });

  test('/api/og renders a PNG for a real model (OgCard path)', async ({ request }) => {
    // The card branch is separate code from the fallback branch, so cover it too —
    // but discover the id rather than pinning one, since a preview can point at
    // either the dev or the prod database.
    const list = await request.get('/api/v1/models?limit=1&sort=Most%20Downloaded');
    test.skip(
      !list.ok(),
      `could not list models to pick a subject (HTTP ${list.status()}) — OgCard path not covered`
    );
    const id = (await list.json())?.items?.[0]?.id as number | undefined;
    test.skip(typeof id !== 'number', 'no published models available — OgCard path not covered');

    const resp = await request.get(`/api/og?type=model&id=${id}&cb=${bust()}`);
    const body = await resp.body();

    expect(resp.status(), `status (body: ${body.subarray(0, 200).toString('utf8')})`).toBe(200);
    expectOgPng(body, resp.headers());
  });
});

// Outside the serial group on purpose: it does not depend on the optimizer having
// run, so it should still report when the renders above are broken.
test('/api/og rejects a malformed query with 400, not 500', async ({ request }) => {
  const resp = await request.get(`/api/og?type=nonsense&id=abc&cb=${bust()}`);
  expect(resp.status()).toBe(400);
});
