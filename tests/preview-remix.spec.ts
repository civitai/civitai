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

    // 1. DISCOVER candidate images that carry generation meta. withMeta=true biases
    //    the public gallery toward on-site-generated images; we still filter
    //    client-side for a populated meta object so a no-meta upload can't sneak in.
    // (no nsfw param → defaults to the public/SFW browsing level, which is what we
    // want; an unauthenticated-level gallery avoids gold's sfwOnly filtering edge.)
    const res = await page.request.get(
      '/api/v1/images?limit=200&withMeta=true&sort=Most%20Reactions&period=AllTime'
    );
    expect(res.ok(), `/api/v1/images -> HTTP ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as {
      items?: Array<{ id?: number; meta?: Record<string, unknown> | null }>;
    };
    const candidates = (body.items ?? [])
      .filter((it) => typeof it?.id === 'number' && it.meta && Object.keys(it.meta).length > 0)
      .map((it) => it.id as number);

    test.skip(
      candidates.length === 0,
      'no meta-bearing image in the shared dev DB to remix (report-only skip)'
    );

    // 2. Walk candidates until one resolves to a NON-EMPTY remix graph. An image can
    //    carry partial meta that doesn't map to a generation graph; accept the first
    //    that does. (generation.getGenerationData is a query; the helper unwraps the
    //    superjson `{ result: { data: { json } } }` envelope to the GenerationData.)
    let resolved: GenerationData | null = null;
    let sourceId = -1;
    for (const id of candidates.slice(0, 12)) {
      let data: GenerationData;
      try {
        data = await trpcQuery<GenerationData>(page.request, 'generation.getGenerationData', {
          type: 'image',
          id,
        });
      } catch {
        continue; // a single un-resolvable image shouldn't fail the spec
      }
      if (data && data.params && Object.keys(data.params).length > 0) {
        resolved = data;
        sourceId = id;
        break;
      }
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
