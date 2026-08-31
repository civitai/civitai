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

Where it is editable: the model-wizard version step (`ModelWizard.tsx`, prefilled
`modelVersion.name + '.safetensors'`) and the file list (`Files.tsx`). Persisted through
`modelFileCreateSchema`/`modelFileUpdateSchema` and exposed via `modelFileSelect`.

**Not built:** a rename input inside `TrainingSelectFile`'s epoch-publish dialog, so a creator
names the file one screen later than planned. Also unbuilt: an architecture segment on the
published name — the pre-publish artifacts get one from `src/shared/utils/training-file-names.ts`,
the published file does not. See `docs/creator-studio-feedback-2026-08-03.md` (architecture-name
suffix).
