import fs from 'fs';
import { expect, test } from '@playwright/test';
import { storageStatePath } from './preview-fixtures';
import { trpcMutation, trpcQuery, uniqueToken } from './preview-trpc';

/**
 * Direct-image-upload e2e for a deployed PR preview.
 *
 * The normal /posts/create upload is a 3-leg handshake the browser drives, then a
 * tRPC attach + publish:
 *   1. POST /api/v1/image-upload -> { id: <B2 object key>, uploadURL: <presigned PUT> }
 *   2. PUT the file bytes straight to Backblaze B2 via the presigned URL
 *   3. post.addImage / post.createWithImages with url = the B2 key (attach the row)
 *   4. publish
 *
 * This drives legs 1-4 request-side (no browser DOM): the load-bearing, regression-prone
 * part is the presigned-PUT-to-B2 round-trip (leg 2) — a service test can't cover the
 * signature/host/binary-body integration, and "B2 creds not configured" already bit
 * preview once. Preview has real B2 image-upload creds wired (pr-deploy-task.yaml
 * S3_IMAGE_B2_*), so legs 1-2 work end-to-end against the real civitai-media-uploads
 * bucket (a tiny PNG is written each run — harmless).
 *
 * Scope ceiling (honest): asserts the upload + attach + PUBLISH DB path. It does NOT
 * assert public-feed visibility — image ingestion/scan is unreachable in preview
 * (placeholder IMAGE_SCANNING_ENDPOINT), so the row stays ingestion:Pending. That does
 * NOT block row creation, attach, or publish.
 *
 * Role: tester (free member, passes the gate; guardedProcedure cleared via onboarding=15).
 */

const PREVIEW_URL = process.env.PREVIEW_URL ?? '';

test.describe('post an image via direct upload (tester)', () => {
  test.use({ storageState: storageStatePath('tester') });

  test('direct upload -> attach -> publish creates a real post with the uploaded image', async ({
    page,
  }) => {
    // Warm the request context against the preview origin (auth cookie + CSRF origin).
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const token = uniqueToken('post-upload');
    const png = fs.readFileSync('tests/fixtures/e2e-pixel.png'); // CWD = repo root (see preview-fixtures)

    // 1. Get an upload URL. The server mints the object key + a presigned B2 PUT URL
    //    (it ignores the request body — randomUUID() key), authed via the cookie.
    const up = await page.request.post('/api/v1/image-upload', {
      headers: {
        'content-type': 'application/json',
        origin: PREVIEW_URL,
        referer: `${PREVIEW_URL}/`,
      },
      data: {},
    });
    expect(up.ok(), `/api/v1/image-upload -> HTTP ${up.status()}`).toBeTruthy();
    const { id: key, uploadURL } = (await up.json()) as { id: string; uploadURL: string };
    expect(typeof key, 'image-upload returns a string object key').toBe('string');
    expect(uploadURL, 'image-upload returns a presigned PUT url').toContain('http');

    // 2. PUT the bytes straight to B2 via the presigned URL — the load-bearing
    //    integration. The presigned PutObjectCommand pins only Bucket+Key (no signed
    //    ContentType), so the content-type header is free. Absolute URL overrides
    //    page.request's baseURL.
    const put = await page.request.fetch(uploadURL, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      data: png,
    });
    expect(put.status(), `B2 presigned PUT -> HTTP ${put.status()}`).toBe(200);

    // 3+4. Attach the uploaded image (url = the B2 key) + publish in one guarded call.
    //    post.createWithImages' internal publish bypasses post.update's verified gate,
    //    so a tester can publish. No Buzz, no GPU.
    const post = await trpcMutation<{ id: number } | null>(
      page.request,
      'post.createWithImages',
      {
        title: token,
        detail: token,
        publish: true,
        images: [{ url: key, type: 'image', width: 1, height: 1, index: 0 }],
      }
    );
    expect(typeof post?.id, 'post.createWithImages returns a numeric post id').toBe('number');

    // 5. Read the owner edit-detail back: the post is published and carries the image.
    //    Assert images.length (not a url match — the stored url may be CDN-transformed;
    //    a freshly self-seeded single-image post can only hold the image we just
    //    attached). Do NOT assert public-feed visibility — ingestion is Pending here.
    const edit = await trpcQuery<{ publishedAt?: string | null; images?: unknown[] }>(
      page.request,
      'post.getEdit',
      { id: post!.id }
    );
    expect(edit?.publishedAt, 'post should be published (publishedAt set)').toBeTruthy();
    expect(
      (edit?.images ?? []).length,
      'post should carry the uploaded image'
    ).toBeGreaterThanOrEqual(1);
  });
});
