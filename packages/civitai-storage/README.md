# @civitai/storage

Server-side **HTTP client for the storage service** (`apps/storage`). It holds no object-store
credentials and does not construct S3 clients: the service holds those, and callers hold only an
endpoint and a token.

The URL helpers (`./url`: `parseKey`, `parseB2Url`, `isB2Url`) are pure and browser-safe. The upload
helpers (`./upload`: `uploadToPresignedUrl`, `uploadMultipart`) move bytes directly to a presigned URL.

Ships **raw** like the other `@civitai/*` packages; consumers transpile it (Next `transpilePackages`,
Vite `ssr.noExternal`).

## Scope

`createStorageClient()` returns typed methods, one per service endpoint: `deleteObject`,
`deleteManyObjects`, `headObject`, `checkFileExists`, the presigners `getPutUrl` / `getGetUrl`, the
multipart set (`getMultipartPutUrl`, `createMultipartUpload`, `presignUploadPart`,
`completeMultipartUpload`, `abortMultipartUpload`), and the streaming pair `uploadStream` /
`getObjectBuffer`.

- Presign methods return a URL the caller uses to transfer bytes **directly** to or from the bucket;
  bytes never flow through the service.
- The client owns the transport: a per-attempt timeout, retries on transient failures (transport,
  timeout, 5xx, 429) with exponential backoff, and a typed `StorageClientError`. Any other 4xx throws at once.

**Domain logic stays in the consuming app**, on top of these methods: ModelFile refcount guards, bucket
allowlists, media-location registration, and deciding which backend a URL belongs to.

The main app's own S3 code is `src/utils/s3-utils.ts`; see `.claude/rules/server.md`.

## Use

```ts
import { createStorageClient } from '@civitai/storage';

const storage = createStorageClient({ onFailure: (failure) => console.warn(failure) }); // wire to your logger

await storage.deleteObject({ key });
const { url } = await storage.getGetUrl({ key, fileName: 'download.zip' });
```

## Config

`StorageClientConfig` in `src/client.ts` is the reference. The endpoint and token fall back to env;
`timeoutMs`, `retries` and `retryBaseMs` tune the transport; `onFailure` is called once per final
failure and should be wired to your logger.
