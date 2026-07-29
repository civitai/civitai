# @civitai/storage

Server-side **low-level S3 / R2 / B2 object client**, shared by the main app and the SvelteKit spokes
so nobody hand-rolls the AWS SDK wiring. Reads config from env (`S3_UPLOAD_*`) with per-call overrides.

The client is **server-only** (holds bucket credentials — never import it into browser code). The URL
helpers (`./url`: `parseKey`, `parseB2Url`, `isB2Url`) are pure and browser-safe.

Ships **raw** like the other `@civitai/*` packages; consumers transpile it (Next `transpilePackages`,
Vite `ssr.noExternal`).

## Scope

The client owns the **S3Client construction** and the **primitive object ops**: `deleteObject`,
`deleteManyObjects`, `putObject`, presigned `getPutUrl` / `getGetUrl` / `getGetUrlByKey`, the
multipart trio (`getMultipartPutUrl` / `completeMultipartUpload` / `abortMultipartUpload`), and
`checkFileExists` / `getFileMetadata`.

Two behaviors to know:

- **`deleteManyObjects` auto-chunks** to the 1000-key `DeleteObjects` limit and resolves to **one
  result per chunk** (`DeleteObjectsCommandOutput[]`, not a single output). Per-key partial failures
  (a 200 with an `Errors` array) are **not** aggregated — iterate the chunk results to inspect them.
- **`client.parseKey(url)` only understands this client's own endpoint host.** It's bound with
  `s3Host` only, so a URL on a *different* backend (e.g. a path-style B2 URL when this is the R2
  client) will mis-parse. Cross-backend routing stays in the app: use the standalone `parseKey`
  / `parseB2Url` / `isB2Url` from `./url` with explicit `s3Host` / `b2Host` for that.

**Domain logic stays in the consuming app**, on top of this client:

- ModelFile refcount guards + bucket allowlists (`urlsSafeToDelete`, `deleteModelFileObject`)
- B2 PUT metrics + client middleware (`instrumentB2Client`, `recordB2PresignIssued`)
- media-location registration for the scanner (`uploadImageBufferToStore`)
- cross-backend URL routing (deciding R2-vs-B2 per URL) and `classifyS3MultipartError`

## Use

```ts
import { createStorageClient } from '@civitai/storage';

// Defaults to the main content bucket (S3_UPLOAD_ENDPOINT / _KEY / _SECRET / _BUCKET / _REGION).
const storage = createStorageClient();

// A different backend/bucket — pass explicit config (e.g. the CSAM bucket, or B2):
const csam = createStorageClient({
  endpoint: process.env.CSAM_UPLOAD_ENDPOINT,
  accessKey: process.env.CSAM_UPLOAD_KEY,
  secretKey: process.env.CSAM_UPLOAD_SECRET,
  bucket: process.env.CSAM_BUCKET,
});

await storage.deleteObject(key);
const { bucket, key } = storage.parseKey(imageUrl);
const { url } = await storage.getGetUrl(imageUrl, { fileName: 'download.zip' });
```

## Config

| Field (option) | Env default | Notes |
| --- | --- | --- |
| `endpoint` | `S3_UPLOAD_ENDPOINT` | required (per client) |
| `accessKey` | `S3_UPLOAD_KEY` | required |
| `secretKey` | `S3_UPLOAD_SECRET` | required |
| `bucket` | `S3_UPLOAD_BUCKET` | optional default bucket; per-call `bucket?` overrides |
| `region` | `S3_UPLOAD_REGION` | optional; defaults to `us-east-1`. R2/custom endpoints ignore it, but real S3/B2 sign requests with it — set it explicitly for B2 (e.g. `us-west-004`) |
| `forcePathStyle` | — | set `true` for B2/path-style endpoints |

Config resolves lazily on first use and throws only if a required field is missing then — a bare import
is side-effect-free.

> **B2-backed clients** need both `region` (SigV4 signs with it — the default `us-east-1` will sign
> wrong) and `forcePathStyle: true`. The main content bucket (R2) needs neither.
