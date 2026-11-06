import { expect, test } from '@playwright/test';

/**
 * HTTP-level regression guard for `/api/og` (Open Graph preview cards) against a
 * DEPLOYED, PRODUCTION-BUILT server. Runs under playwright.preview.config.ts —
 * the `preview-*.spec.ts` filename is what enrolls it in the `preview-smoke`
 * project, so this needs no pipeline change.
 *
 * Over HTTP rather than in-process because the defect it guards against lives in
 * the built artifact: `@vercel/og`'s dynamic require was not traced under
 * `output: 'standalone'` and was dropped from the image
 * (see `outputFileTracingIncludes['/api/og']` in next.config.mjs).
 *
 * The image optimizer is off (`images.unoptimized`, civitai/civitai#6814, guarded by
 * src/server/services/__tests__/no-reenabled-image-optimizer.test.ts). If it is
 * re-enabled, these renders must run after a forced `/_next/image` cache MISS: the
 * optimizer's sharp init blocks the SVG loader next/og needs (see
 * src/tests/api/og.image-optimizer-sharp.test.ts). The old warmup is in this file's
 * history: `git log -S CANDIDATE_WIDTHS -- tests/preview-og.spec.ts`.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

test('/api/og rejects a malformed query with 400, not 500', async ({ request }) => {
  const resp = await request.get(`/api/og?type=nonsense&id=abc&cb=${bust()}`);
  expect(resp.status()).toBe(400);
});
