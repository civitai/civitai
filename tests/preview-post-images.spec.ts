import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, uniqueToken } from './preview-trpc';

/**
 * Post-an-image-from-the-generator e2e for a deployed PR preview.
 *
 * The generator "Post" action (GeneratedImageActions.tsx) ultimately persists the
 * image via post.create -> post.addImage, where `url` is the UUID key the browser
 * minted by re-uploading the orchestrator blob to object storage. The server-side
 * createImage (image.service.ts) inserts the Image row using that url VERBATIM —
 * there is NO blob-existence check — so a fabricated UUID exercises the exact
 * post-with-images ATTACH contract without a real generation, upload, Buzz, or GPU.
 *
 * Scope (honest): this covers the SERVER contract (post.create + post.addImage — the
 * image-attach mutation no other preview spec exercises). It deliberately does NOT
 * drive the generator UI glue (selection -> transmitter store -> blob re-upload),
 * which needs the external GPU orchestrator + object storage and is unit-covered
 * upstream; and it does NOT publish/assert public visibility, because image
 * ingestion (the external scanner) is unreachable in preview so the row stays
 * Pending. The attach itself returns the created Image row, which IS the proof.
 *
 * Role: tester (free member that passes the preview gate; post.create + post.addImage
 * are guardedProcedures / MediaWrite — the ci-smoke tester fixture clears them, same
 * as preview-engagement/preview-report which already self-seed posts).
 */

test.describe('post an image from the generator (tester)', () => {
  test.use({ storageState: storageStatePath('tester') });

  test('post.create then post.addImage attaches a generated image to a post', async ({ page }) => {
    // Warm the request context against the preview origin (shares the auth cookie +
    // a real navigated origin; mirrors the other mutation specs).
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const token = uniqueToken('post-from-gen');

    // 1. Self-seed a draft post (metadata only) — same as preview-engagement/report.
    const post = await trpcMutation<{ id: number } | null>(page.request, 'post.create', {
      title: token,
      detail: token,
    });
    expect(typeof post?.id, 'post.create should return a numeric post id').toBe('number');

    // 2. Attach an image to it. `url` is a fabricated v4 UUID standing in for the
    //    object-storage key the generator flow would have minted; addPostImageSchema
    //    accepts a uuid and `type` defaults to image, so postId + url + index suffice.
    const fakeKey = randomUUID();
    const image = await trpcMutation<{ id: number } | null>(page.request, 'post.addImage', {
      postId: post!.id,
      url: fakeKey,
      index: 0,
      width: 512,
      height: 512,
    });

    // 3. post.addImage returns the created Image row (editPostImageSelect) — its numeric
    //    id is the proof the image attached to the post. No read-back query needed (and
    //    we avoid image.getInfinite, which routes through Meilisearch — unreachable in
    //    preview). No publish: ingestion stays Pending in preview by design.
    expect(
      typeof image?.id,
      'post.addImage should return the attached image with a numeric id'
    ).toBe('number');
    expect(image!.id, 'attached image id should be positive').toBeGreaterThan(0);
  });
});
