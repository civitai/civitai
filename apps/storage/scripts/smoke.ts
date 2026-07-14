/*
 * Real-S3 integration smoke for apps/storage.
 *
 * Boots the Fastify service IN-PROCESS on an ephemeral port and drives it through the real
 * `@civitai/storage` client + browser uploader — so it exercises the whole stack end-to-end against a
 * REAL bucket: client -> service -> s3.ts (presign/head/delete/multipart) -> S3.
 *
 * Run against staging/real creds (never mocks):
 *   S3_UPLOAD_ENDPOINT=... S3_UPLOAD_KEY=... S3_UPLOAD_SECRET=... S3_UPLOAD_BUCKET=... \
 *   pnpm --filter @civitai/storage-app smoke
 *
 * Optional: STORAGE_TOKEN (exercises the auth gate), STORAGE_SMOKE_BACKEND (default|b2|b2Image|csam,
 * default `default`), STORAGE_SMOKE_KEEP=1 (skip cleanup). Exits 0 on success, 1 on any failure, and 0
 * with a SKIP message when the chosen backend's creds are absent (so CI can call it unconditionally).
 */
import { buildServer } from '../src/app';
import { createStorageClient } from '@civitai/storage';

type Backend = 'default' | 'b2' | 'b2Image' | 'csam';
const backend = (process.env.STORAGE_SMOKE_BACKEND ?? 'default') as Backend;
const keep = process.env.STORAGE_SMOKE_KEEP === '1';

// Which env trio must be present for the chosen backend (endpoint/key/secret). Mirrors backends.ts.
const REQUIRED: Record<Backend, string[]> = {
  default: ['S3_UPLOAD_ENDPOINT', 'S3_UPLOAD_KEY', 'S3_UPLOAD_SECRET'],
  b2: ['S3_UPLOAD_B2_ENDPOINT', 'S3_UPLOAD_B2_ACCESS_KEY', 'S3_UPLOAD_B2_SECRET_KEY'],
  b2Image: ['S3_IMAGE_B2_ENDPOINT', 'S3_IMAGE_B2_ACCESS_KEY', 'S3_IMAGE_B2_SECRET_KEY'],
  csam: ['CSAM_UPLOAD_ENDPOINT', 'CSAM_UPLOAD_KEY', 'CSAM_UPLOAD_SECRET'],
};

const missing = REQUIRED[backend].filter((k) => !process.env[k]);
if (missing.length) {
  console.log(`SKIP: storage smoke — backend "${backend}" not configured (missing ${missing.join(', ')}).`);
  process.exit(0);
}

const log = (msg: string) => console.log(`  • ${msg}`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function* generate(totalBytes: number, pieceSize: number): AsyncGenerator<Uint8Array> {
  let sent = 0;
  while (sent < totalBytes) {
    const n = Math.min(pieceSize, totalBytes - sent);
    // Fill with a positional byte so a corrupt/misordered part is detectable on read-back.
    const piece = new Uint8Array(n);
    for (let i = 0; i < n; i++) piece[i] = (sent + i) % 251;
    yield piece;
    sent += n;
  }
}

async function main() {
  console.log(`storage smoke — backend "${backend}"`);
  const app = await buildServer();
  const address = await app.listen({ port: 0, host: '127.0.0.1' }); // e.g. http://127.0.0.1:53187
  const client = createStorageClient({ endpoint: address, token: process.env.STORAGE_TOKEN });
  const stamp = `${Date.now()}-${process.pid}`;
  const singleKey = `smoke/${stamp}/single.bin`;
  const multiKey = `smoke/${stamp}/multi.bin`;
  const created: string[] = [];

  try {
    // --- single-object round-trip: presign PUT -> upload -> head -> presign GET -> read back -> delete ---
    const payload = Buffer.from(`storage smoke ${stamp}\n`.repeat(64));
    const put = await client.getPutUrl({ backend, key: singleKey });
    log(`presigned PUT (${put.bucket})`);
    const putRes = await fetch(put.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload,
    });
    assert(putRes.ok, `PUT to presigned URL failed (${putRes.status})`);
    created.push(singleKey);
    log('uploaded via presigned URL');

    const head = await client.headObject({ backend, key: singleKey });
    assert(head.exists, 'head after upload: object should exist');
    assert(head.size === payload.byteLength, `head size ${head.size} !== ${payload.byteLength}`);
    log(`head ok (size ${head.size})`);

    const get = await client.getGetUrl({ backend, key: singleKey });
    const readBack = Buffer.from(await (await fetch(get.url)).arrayBuffer());
    assert(readBack.equals(payload), 'read-back bytes differ from uploaded');
    log('presigned GET read-back matches');

    // getObjectBuffer helper (server-side read path) should return the same bytes.
    const viaHelper = Buffer.from(await client.getObjectBuffer({ backend, key: singleKey }));
    assert(viaHelper.equals(payload), 'getObjectBuffer bytes differ');
    log('getObjectBuffer matches');

    // --- streaming multipart round-trip: uploadStream (5MB parts) -> read back -> verify size ---
    const CHUNK = 5 * 1024 * 1024;
    const TOTAL = 12 * 1024 * 1024; // 3 parts: 5MB, 5MB, 2MB
    const streamRes = await client.uploadStream(
      { backend, key: multiKey, chunkSize: CHUNK },
      generate(TOTAL, 1024 * 1024)
    );
    created.push(multiKey);
    assert(streamRes.parts.length === 3, `expected 3 parts, got ${streamRes.parts.length}`);
    log(`streaming multipart uploaded (${streamRes.parts.length} parts)`);

    const mHead = await client.headObject({ backend, key: multiKey });
    assert(mHead.exists && mHead.size === TOTAL, `multipart head size ${mHead.size} !== ${TOTAL}`);
    const mGet = await client.getGetUrl({ backend, key: multiKey });
    const mBytes = Buffer.from(await (await fetch(mGet.url)).arrayBuffer());
    assert(mBytes.byteLength === TOTAL, `multipart read-back size ${mBytes.byteLength} !== ${TOTAL}`);
    assert(mBytes[0] === 0 && mBytes[TOTAL - 1] === (TOTAL - 1) % 251, 'multipart boundary bytes wrong');
    log('streaming multipart read-back verified');

    // --- delete + confirm gone ---
    if (!keep) {
      for (const key of created) await client.deleteObject({ backend, key });
      const gone = await client.headObject({ backend, key: singleKey });
      assert(!gone.exists, 'head after delete: object should be gone');
      log('deleted + confirmed gone');
    } else {
      log(`STORAGE_SMOKE_KEEP=1 — left ${created.join(', ')}`);
    }

    console.log('\n✅ storage smoke PASSED');
  } finally {
    await app.close();
  }
}

main().catch(async (err) => {
  console.error('\n❌ storage smoke FAILED\n', err);
  process.exit(1);
});
