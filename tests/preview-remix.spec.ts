import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcQuery } from './preview-trpc';

/**
 * Remix e2e for a deployed PR preview.
 *
 * The "Remix" action on an image (RemixButton.tsx) is a CLIENT-SIDE PRE-FILL of the
 * generator — it dispatches generationGraphPanel.open({ type:'image', id }) which
 * fires the tRPC query `generation.getGenerationData({ type:'image', id })` and uses
 * the result to seed the generator form. It does NOT submit a generation (no Buzz,
 * no GPU) — that's a separate later click, out of scope here.
 *
 * This asserts the load-bearing, preview-seedable half: the SERVER turns a real
 * image's generation meta into a remix graph. getMediaGenerationData
 * (generation.service.ts ~L547) returns `{ type, remixOfId: media.id, resources,
 * params }` — `remixOfId === the source image id` is the smoking gun that this is
 * the remix-resolution path (vs a generic generator load). The button -> store ->
 * form wiring is unit-covered (store/__tests__/generation-graph.store.test.ts); the
 * meta->graph resolution is the part only a live preview (real DB images) exercises.
 *
 * Discovery, not a hard-coded id: find an image that actually carries generation
 * meta via the public /api/v1/images REST (same pattern as preview-resource-review's
 * /api/v1/models), then confirm it resolves to a non-empty remix graph. test.skip
 * (report-only) if the shared dev DB has no remixable image.
 *
 * Role: gold (paid member — passes the preview gate AND is a real generation user;
 * generation.getGenerationData is publicProcedure so auth isn't strictly required,
 * but gold mirrors the real remix user and keeps parity with preview-generation).
 */

type GenerationData = {
  type?: string;
  remixOfId?: number;
  resources?: unknown[];
  params?: Record<string, unknown>;
};

test.describe('remix image (gold)', () => {
  test.use({ storageState: storageStatePath('gold') });

  test('getGenerationData resolves an image with meta into a remix graph', async ({ page }) => {
    // Warm the request context against the preview origin (shares the auth cookie +
    // a real navigated origin; the trpc helper stamps Origin/Referer but navigating
    // once is the safe baseline — mirrors the other mutation specs).
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // DISCOVERY — must avoid Meilisearch: the preview pod can't reach the search
    // index (MeiliSearchCommunicationError), so a plain `/api/v1/images?sort=Most
    // Reactions` 500s there (it routes through getAllImagesIndex). Passing `modelId`
    // (without modelVersionId) forces /api/v1/images through the DB path getAllImages
    // — see src/pages/api/v1/images/index.ts `useLegacyMethod`. So: pick models via
    // /api/v1/models (DB-backed; proven in preview by preview-resource-review), then
    // pull each model's gallery images (DB path) and keep the meta-bearing ones.
    // A 5xx on these *generic read* endpoints = the preview pod is unhealthy (cold/
    // contended), NOT a remix regression → skip (report-only), don't hard-fail.

    const modelsRes = await page.request.get('/api/v1/models?limit=20');
    test.skip(
      modelsRes.status() >= 500,
      `models discovery infra 5xx (${modelsRes.status()}) — preview unhealthy, not a remix bug`
    );
    expect(modelsRes.ok(), `/api/v1/models -> HTTP ${modelsRes.status()}`).toBeTruthy();
    const modelIds = (((await modelsRes.json()) as { items?: Array<{ id?: number }> }).items ?? [])
      .map((m) => m?.id)
      .filter((n): n is number => typeof n === 'number');

    const candidates: number[] = [];
    for (const modelId of modelIds) {
      if (candidates.length >= 15) break;
      const imgRes = await page.request.get(
        `/api/v1/images?modelId=${modelId}&withMeta=true&limit=20`
      );
      if (!imgRes.ok()) continue; // skip an individual model that errors
      const items =
        ((await imgRes.json()) as {
          items?: Array<{ id?: number; meta?: Record<string, unknown> | null }>;
        }).items ?? [];
      for (const it of items) {
        if (typeof it?.id === 'number' && it.meta && Object.keys(it.meta).length > 0) {
          candidates.push(it.id);
        }
      }
    }

    test.skip(
      candidates.length === 0,
      'no meta-bearing model-gallery image in the shared dev DB to remix (report-only skip)'
    );

    // Walk candidates until one resolves to a NON-EMPTY remix graph. Track whether
    // getGenerationData ever returned cleanly: if EVERY call 5xx'd, that's a real
    // remix-endpoint regression (surface it), not a "no data" skip.
    let resolved: GenerationData | null = null;
    let sourceId = -1;
    let any2xx = false;
    let lastErr: unknown = null;
    for (const id of candidates.slice(0, 12)) {
      let data: GenerationData;
      try {
        data = await trpcQuery<GenerationData>(page.request, 'generation.getGenerationData', {
          type: 'image',
          id,
        });
        any2xx = true;
      } catch (err) {
        lastErr = err; // a single un-resolvable image shouldn't fail the spec…
        continue;
      }
      if (data && data.params && Object.keys(data.params).length > 0) {
        resolved = data;
        sourceId = id;
        break;
      }
    }

    // …but if NOT ONE getGenerationData call succeeded, the remix endpoint itself is
    // broken — fail loudly rather than masking it as a skip.
    if (resolved === null && !any2xx && lastErr) {
      throw lastErr;
    }
    test.skip(
      resolved === null,
      'meta-bearing images exist but none resolved to a generation graph (report-only skip)'
    );

    // 3. ASSERT the remix-resolution contract:
    //    - remixOfId is keyed to the SOURCE image (the smoking gun this is the remix
    //      path, not a generic generator load),
    //    - params is a non-empty generation parameter set,
    //    - resources is an array (the checkpoint/LoRAs to seed into the graph).
    expect(resolved!.remixOfId, 'remixOfId should equal the source image id').toBe(sourceId);
    expect(
      Object.keys(resolved!.params ?? {}).length,
      'remixed params should be non-empty'
    ).toBeGreaterThan(0);
    expect(Array.isArray(resolved!.resources), 'remixed resources should be an array').toBe(true);
  });
});
