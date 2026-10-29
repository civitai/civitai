import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, uniqueToken } from './preview-trpc';
import { UPLOAD_FIXTURE, uploadImage } from './preview-upload';

/**
 * Post-an-image-from-the-generator e2e for a deployed PR preview.
 *
 * The generator "Post" action (postGeneratedMedia.ts) hands the generated images to the post
 * dropzone, which re-uploads each one to object storage and then persists it via
 * post.create -> post.addImage, where `url` is the object key the upload endpoint minted.
 *
 * post.addImage only accepts a key that the server issued to the caller: the upload endpoint
 * records each key it mints against the session's user (recordUploadKeyOwner), and image
 * creation refuses any other key with "This cover image is no longer available. Please
 * re-upload it." (assertClientKeysIssuedToCaller in image-url-ownership.ts). A fabricated
 * UUID is therefore refused. So this test first uploads a real image through the upload
 * endpoint (tests/preview-upload.ts, shared with preview-post-upload) and attaches the key it
 * was issued.
 *
 * Scope (honest): this covers the SERVER contract (key issue -> post.create ->
 * post.addImage, the image-attach mutation no other preview spec exercises). It does NOT
 * drive the generator UI glue (selection -> transmitter store -> dropzone re-upload), which
 * needs the external GPU orchestrator and is unit-covered upstream, and it uses the
 * single-PUT upload endpoint rather than the dropzone's multipart one (both record the key
 * the same way). It does NOT publish or assert public visibility, because image ingestion
 * (the external scanner) is unreachable in preview so the row stays Pending. The attach
 * itself returns the created Image row, which IS the proof.
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

    // 2. Upload an image the way the browser does; the server issues its key to the tester.
    const key = await uploadImage(page.request);

    // 3. Attach it. addPostImageSchema accepts the key as `url` and `type` defaults to
    //    image, so postId + url + index suffice.
    const image = await trpcMutation<{ id: number } | null>(page.request, 'post.addImage', {
      postId: post!.id,
      url: key,
      index: 0,
      width: UPLOAD_FIXTURE.width,
      height: UPLOAD_FIXTURE.height,
    });

    // 4. post.addImage returns the created Image row (editPostImageSelect) — its numeric
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
