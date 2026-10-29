import fs from 'fs';
import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Uploads a real image to a deployed PR preview the way the browser does, and returns the
 * object key the server issued to the caller. NOT a test file (excluded from testMatch).
 *
 * It drives the single-PUT upload (useCFImageUpload / useFileUpload):
 *   1. POST /api/v1/image-upload -> { id: <object key>, uploadURL: <presigned PUT> }
 *      The server mints the key and records it as issued to the session's user
 *      (recordUploadKeyOwner). post.addImage / post.createWithImages refuse a key that was
 *      not issued to the caller (assertClientKeysIssuedToCaller), so the key must come from an
 *      upload endpoint.
 *   2. PUT the bytes to object storage via the presigned URL.
 *
 * The post dropzone, which the generator "Post" action hands its images to, uploads through
 * the multipart sibling (/api/v1/image-upload/multipart). That endpoint mints and records the
 * key with the same recordUploadKeyOwner call; only the byte transfer differs.
 *
 * Pass `page.request` (it carries the test's storageState auth cookie) after navigating the
 * page to the preview origin.
 */

const PREVIEW_URL = process.env.PREVIEW_URL ?? '';

/** The 1x1 PNG the upload writes; pass these as the attached image's width and height. */
export const UPLOAD_FIXTURE = { path: 'tests/fixtures/e2e-pixel.png', width: 1, height: 1 };

export async function uploadImage(request: APIRequestContext): Promise<string> {
  const png = fs.readFileSync(UPLOAD_FIXTURE.path); // CWD = repo root (see preview-fixtures)

  // The server ignores the body: it mints the key itself.
  const up = await request.post('/api/v1/image-upload', {
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

  // The presigned PutObjectCommand pins only Bucket+Key (no signed ContentType), so the
  // content-type header is free. An absolute URL overrides page.request's baseURL.
  const put = await request.fetch(uploadURL, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    data: png,
  });
  expect(put.status(), `presigned PUT -> HTTP ${put.status()}`).toBe(200);

  return key;
}
