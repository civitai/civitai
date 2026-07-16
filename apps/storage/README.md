# storage (apps/storage)

Fastify **object-storage service**. Owns all bucket credentials (R2 main content, Backblaze B2
model-files + image buckets, CSAM evidence) and exposes a small authenticated HTTP surface so the main
app and the SvelteKit spokes never hold S3 creds themselves. Callers use the `@civitai/storage` client.

Built from the pnpm monorepo (tsup → `dist/server.js`), same shape as `apps/notifications`.

## Why a service (not just a library)

S3 creds can delete/overwrite prod content buckets. Centralizing them in one app means each consuming
app holds only `STORAGE_ENDPOINT` + a shared token, and per-caller authz can live here — instead of
spreading bucket-delete creds into every spoke. **Bytes never flow through the service**: presign
endpoints return a URL the caller uses to transfer directly to/from S3; only delete / head /
multipart-control are round-trips.

## API

All routes are POST + bearer-token (`STORAGE_TOKEN`), except the ops routes. A request names a
`backend` (`default` | `b2` | `b2Image` | `csam`); the service resolves that backend's bucket + creds.
The wire contract is the zod schema in `@civitai/storage` (`schema.ts`) — the single source of truth.

| Route | Purpose |
| --- | --- |
| `GET /health` | no-dep liveness/readiness |
| `GET /metrics` | Prometheus scrape (private-by-XFF) |
| `POST /objects/delete` | delete one object |
| `POST /objects/delete-many` | delete many (auto-chunked to 1000/call) |
| `POST /objects/head` | exists + metadata |
| `POST /presign/put` | presigned PUT URL |
| `POST /presign/get` | presigned GET URL (by `key` or full `url`) |
| `POST /presign/multipart` | create multipart upload + presigned part URLs |
| `POST /multipart/complete` | complete a multipart upload |
| `POST /multipart/abort` | abort a multipart upload |

## Config

See `.env.example`. The **default** backend (R2, `S3_UPLOAD_*`) is required at boot; other backends fail
lazily on first use with a clear error. `STORAGE_TOKEN` is required in production (empty disables the
auth gate — dev only).
