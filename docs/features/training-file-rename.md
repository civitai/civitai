# Safetensors file rename before publishing — SHIPPED

**Shipped in `e5573c88f6` (#2737, 2026-07-08) as `overrideName` on `ModelFile`.** Kept as the
record of what was built and the one piece that was not.

A published training file's stored `name` is the orchestrator blob id — `moveAssetFromBlob` in
`src/server/services/training.service.ts` writes `<blobId>.safetensors`; the legacy
`moveAssetFromJob` branch instead keeps the job's asset name (`abc123_0000010.safetensors`).
Both are opaque, neither collides.

`overrideName` (`schema.full.prisma:1251`) overrides what users see and what a browser names the
download; the S3 key and `name` are untouched, so it is fully reversible. `getDownloadFilename()`
in `src/server/services/file.service.ts` prefers it, which is why the public API and the download
handler needed no change.

Where it is editable: the model-wizard version step for trained models (`ModelWizard.tsx`,
prefilled `modelVersion.name + '.safetensors'`), and the file list (`Files.tsx`) for every saved
primary file of any model, uploaded or trained. Persisted through
`modelFileCreateSchema`/`modelFileUpdateSchema` and exposed via `modelFileSelect`.

The server rewrites every new value with `sanitizeOverrideName` (`src/utils/model-file-naming.ts`):
one path segment, no control, quote or `%XX` characters, at most 200 UTF-8 bytes, and the stored file's
extension when that is plain alphanumerics. Every download name `resolveModelFileName` returns is
also made header-safe at read time, so older names and kept upload names are covered. The in-repo S3 links and the training epoch download
build their header with `attachmentContentDisposition` (`src/utils/content-disposition.ts`), an
ASCII `filename` plus an RFC 5987 `filename*`.

A trained file nobody named still downloads readably: `resolveModelFileName` treats the stored
blob-id name (`<26-char Crockford id>[.<8-char token>].safetensors`, nothing looser) as generic, so a LoRA
falls back to `<model>_<version>.safetensors` instead of keeping it.

**Not built:** a rename input inside `TrainingSelectFile`'s epoch-publish dialog, so a creator
names the file one screen later than planned. Also unbuilt: an architecture segment on the
published name — the pre-publish artifacts get one from `src/shared/utils/training-file-names.ts`,
the published file does not. See `docs/creator-studio-feedback-2026-08-03.md` (architecture-name
suffix).
