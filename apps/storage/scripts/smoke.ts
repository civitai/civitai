/*
 * Real-S3 integration smoke for apps/storage.
 *
 * Boots the Fastify service IN-PROCESS on an ephemeral port and drives it through the real
 * `@civitai/storage` client + browser uploader — so it exercises the whole stack end-to-end against a
 * REAL bucket: client -> service -> s3.ts (presign/head/delete/multipart) -> S3.
 *
 * Auto-loads apps/storage/.env (fill-gaps: a real shell var still wins), so with the app's .env
 * populated you can just run:
 *   pnpm --filter @civitai/storage-app smoke
 * Override per run in the shell, e.g. STORAGE_SMOKE_BACKEND=b2.
 *
 * Env: S3_UPLOAD_* (default) / S3_UPLOAD_B2_* (b2) / S3_IMAGE_B2_* (b2Image) / CSAM_UPLOAD_* (csam);
 * STORAGE_TOKEN (exercises the auth gate); STORAGE_SMOKE_BACKEND (default|b2|b2Image|csam, default
 * `default`); STORAGE_SMOKE_KEEP=1 (skip cleanup). A NON-LOCAL endpoint requires STORAGE_SMOKE_CONFIRM=1
 * (guard against an accidental run on a real bucket). Exits 0 on success, 1 on failure/refusal, and 0
 * with a SKIP message when the chosen backend's creds are absent (so CI can call it unconditionally).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCsamStorageClient, createStorageClient } from '@civitai/storage';

// Load apps/storage/.env into process.env (fill gaps only — a real shell var still wins), so the smoke
// runs from the app's .env without exporting anything (tsx doesn't auto-load .env). Runs BEFORE the
// (dynamic) import of ../src/app so env.ts's module-level reads (STORAGE_TOKEN, …) see the values.
// No-op if the file is absent (CI / fresh checkout).
function loadDotEnv() {
  let text: string;
  try {
    text = readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

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

const ENDPOINT_VAR: Record<Backend, string> = {
  default: 'S3_UPLOAD_ENDPOINT',
  b2: 'S3_UPLOAD_B2_ENDPOINT',
  b2Image: 'S3_IMAGE_B2_ENDPOINT',
  csam: 'CSAM_UPLOAD_ENDPOINT',
};
const BUCKET_VAR: Record<Backend, string> = {
  default: 'S3_UPLOAD_BUCKET',
  b2: 'S3_UPLOAD_B2_BUCKET',
  b2Image: 'S3_IMAGE_B2_BUCKET',
  csam: 'CSAM_BUCKET_NAME',
};

const missing = REQUIRED[backend].filter((k) => !process.env[k]);
if (missing.length) {
  console.log(
    `SKIP: storage smoke — backend "${backend}" not configured (missing ${missing.join(', ')}).`
  );
  process.exit(0);
}

const endpoint = process.env[ENDPOINT_VAR[backend]] ?? '';
const bucket = process.env[BUCKET_VAR[backend]] ?? '(backend default)';
let endpointHost = '';
try {
  endpointHost = new URL(endpoint).hostname;
} catch {
  // leave empty → treated as non-local (must confirm)
}
const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpointHost);

// Guard against an accidental run on a real bucket: this smoke WRITES + DELETES objects (under a
// smoke/<...>/ prefix). A non-local endpoint requires an explicit STORAGE_SMOKE_CONFIRM=1.
if (!isLocal && process.env.STORAGE_SMOKE_CONFIRM !== '1') {
  console.error(`REFUSED: storage smoke targets a NON-LOCAL endpoint.`);
  console.error(`  backend:  ${backend}`);
  console.error(`  endpoint: ${endpoint || '(unset)'}`);
  console.error(`  bucket:   ${bucket}`);
  console.error(`This run would write + delete test objects (smoke/<...>/) on that bucket.`);
  console.error(
    `Re-run with STORAGE_SMOKE_CONFIRM=1 to proceed, or point it at a local S3 (MinIO).`
  );
  process.exit(1);
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

// A backend-agnostic view over the two clients: the primary client injects the (public) backend on each
// call; the CSAM client pins backend:csam internally and exposes the same ops without a backend param.
function makeOps(endpoint: string, backend: Backend, token: string | undefined) {
  if (backend === 'csam') {
    const c = createCsamStorageClient({ endpoint, token });
    return {
      getPutUrl: (key: string) => c.getPutUrl({ key }),
      getGetUrl: (key: string) => c.getGetUrl({ key }),
      headObject: (key: string) => c.headObject({ key }),
      getObjectBuffer: (key: string) => c.getObjectBuffer({ key }),
      uploadStream: (key: string, chunkSize: number, src: AsyncIterable<Uint8Array>) =>
        c.uploadStream({ key, chunkSize }, src),
      deleteObject: (key: string) => c.deleteObject({ key }),
    };
  }
  const b = backend; // narrowed to PublicStorageBackend
  const c = createStorageClient({ endpoint, token });
  return {
    getPutUrl: (key: string) => c.getPutUrl({ backend: b, key }),
    getGetUrl: (key: string) => c.getGetUrl({ backend: b, key }),
    headObject: (key: string) => c.headObject({ backend: b, key }),
    getObjectBuffer: (key: string) => c.getObjectBuffer({ backend: b, key }),
    uploadStream: (key: string, chunkSize: number, src: AsyncIterable<Uint8Array>) =>
      c.uploadStream({ backend: b, key, chunkSize }, src),
    deleteObject: (key: string) => c.deleteObject({ backend: b, key }),
  };
}

async function main() {
  console.log(`storage smoke — backend "${backend}" | endpoint ${endpoint} | bucket ${bucket}`);
  // Dynamic import: ../src/app -> env.ts reads STORAGE_TOKEN etc. at module load, so it must evaluate
  // AFTER loadDotEnv() (top-level static imports run before top-level code).
  const { buildServer } = await import('../src/app');
  const app = await buildServer();
  const address = await app.listen({ port: 0, host: '127.0.0.1' }); // e.g. http://127.0.0.1:53187
  // CSAM is deliberately walled off from the primary client, so the smoke drives it through the
  // dedicated wrapper (which pins backend:csam). Both expose the ops this smoke exercises, so the rest
  // of the flow below is backend-agnostic via `ops`.
  const ops = makeOps(address, backend, process.env.STORAGE_TOKEN);
  const stamp = `${Date.now()}-${process.pid}`;
  const singleKey = `smoke/${stamp}/single.bin`;
  const multiKey = `smoke/${stamp}/multi.bin`;
  const created: string[] = [];

  try {
    // --- single-object round-trip: presign PUT -> upload -> head -> presign GET -> read back -> delete ---
    const payload = Buffer.from(`storage smoke ${stamp}\n`.repeat(64));
    const put = await ops.getPutUrl(singleKey);
    log(`presigned PUT (${put.bucket})`);
    const putRes = await fetch(put.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload,
    });
    assert(putRes.ok, `PUT to presigned URL failed (${putRes.status})`);
    created.push(singleKey);
    log('uploaded via presigned URL');

    const head = await ops.headObject(singleKey);
    assert(head.exists, 'head after upload: object should exist');
    assert(head.size === payload.byteLength, `head size ${head.size} !== ${payload.byteLength}`);
    log(`head ok (size ${head.size})`);

    const get = await ops.getGetUrl(singleKey);
    const readBack = Buffer.from(await (await fetch(get.url)).arrayBuffer());
    assert(readBack.equals(payload), 'read-back bytes differ from uploaded');
    log('presigned GET read-back matches');

    // getObjectBuffer helper (server-side read path) should return the same bytes.
    const viaHelper = Buffer.from(await ops.getObjectBuffer(singleKey));
    assert(viaHelper.equals(payload), 'getObjectBuffer bytes differ');
    log('getObjectBuffer matches');

    // --- streaming multipart round-trip: uploadStream (5MB parts) -> read back -> verify size ---
    const CHUNK = 5 * 1024 * 1024;
    const TOTAL = 12 * 1024 * 1024; // 3 parts: 5MB, 5MB, 2MB
    const streamRes = await ops.uploadStream(multiKey, CHUNK, generate(TOTAL, 1024 * 1024));
    created.push(multiKey);
    assert(streamRes.parts.length === 3, `expected 3 parts, got ${streamRes.parts.length}`);
    log(`streaming multipart uploaded (${streamRes.parts.length} parts)`);

    const mHead = await ops.headObject(multiKey);
    assert(mHead.exists && mHead.size === TOTAL, `multipart head size ${mHead.size} !== ${TOTAL}`);
    const mGet = await ops.getGetUrl(multiKey);
    const mBytes = Buffer.from(await (await fetch(mGet.url)).arrayBuffer());
    // Full-content compare (not just size + endpoints): a swapped/shifted interior part is caught too.
    const expected = Buffer.alloc(TOTAL);
    for (let i = 0; i < TOTAL; i++) expected[i] = i % 251;
    assert(mBytes.equals(expected), 'streaming multipart read-back content differs from source');
    log('streaming multipart read-back verified (full content)');

    // --- delete + confirm gone ---
    if (!keep) {
      for (const key of created) await ops.deleteObject(key);
      const gone = await ops.headObject(singleKey);
      assert(!gone.exists, 'head after delete: object should be gone');
      log('deleted + confirmed gone');
    } else {
      log(`STORAGE_SMOKE_KEEP=1 — left ${created.join(', ')}`);
    }

    console.log('\n✅ storage smoke PASSED');
  } finally {
    // Safety net: best-effort remove everything we created, even if an assertion above threw mid-run —
    // so a run against a real bucket can never orphan test objects. S3 delete is idempotent, so
    // re-deleting the happy-path objects is harmless. (STORAGE_SMOKE_KEEP=1 opts out.)
    if (!keep) {
      for (const key of created) {
        await ops.deleteObject(key).catch(() => {});
      }
    }
    await app.close();
  }
}

main().catch(async (err) => {
  console.error('\n❌ storage smoke FAILED\n', err);
  process.exit(1);
});
