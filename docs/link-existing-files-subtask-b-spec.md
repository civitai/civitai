# Subtask B — Link to Official Instead of Upload if Hash Matches — Implementation Spec

_Date: 2026-07-01. Parent design: [`link-existing-files-design.md`](./link-existing-files-design.md).
ClickUp [868k6917j](https://app.clickup.com/t/868k6917j) (epic
[868k69041](https://app.clickup.com/t/868k69041) "Dedupe Model Resources")._

This spec covers **all of Subtask B**: prevent-the-upload on the client (B.1a), the server post-scan
safety net (B.1b), the official-uploads reclaim job (B.2), plus the read-path staleness work B
depends on. Subtask A is committed (`40840bf7c2`) but **not yet merged** — B ships on the **same
branch / same PR** as A, so the required read-path staleness fix (§6, which also covers A's pointers)
lands here rather than in a follow-up.

---

## 0. Resolved blocker

**Civitai's stored `ModelFileHash.SHA256` covers the full file byte range** (confirmed by team
2026-07-01). SHA256 == byte identity → it is the object-sharing / dedup key. **BLAKE3 is dropped
entirely** (it was only the fallback for a header-skipped SHA256). CRC32 is optional cheap-reject,
not required. Hashes are stored/compared **lowercased**.

---

## 1. Scope & shared foundation

### 1.1 What B dedupes

**Component/accessory files only** — VAE, Text Encoder, CLIP, ControlNet, etc. (anything
`inferComponentType` resolves + that `addLinkedComponent` accepts). **Primary `Model` / `Pruned
Model` weights are out of scope** and cannot be replaced: `addLinkedComponent`'s existing
`replaceFileId` guard (`model-version.service.ts:2153-2154`) rejects those types. This is enforced for
free — B.1b/B.2 must additionally pre-filter so they never *attempt* a primary-weights replacement
(cheaper than catching the throw).

### 1.2 The reused primitive (already shipped in A)

All three parts call `addLinkedComponent` (`model-version.service.ts:2075`) — it creates the
`RecommendedResource` pointer **and** deletes `replaceFileId` in one call. Pointer direction:

- `sourceId = input.id` = the **host/redundant** version (the user's version, or the checkpoint)
- `resourceId = targetVersionId` = the **official** version
- `settings.fileId = targetFileId` = the **official** file (the canonical bytes served)
- dedupe key `(sourceId, resourceId, settings.fileId)` → idempotent

Server-side invocation template is the A.2 backfill (`src/pages/api/admin/temp/dedupe-official-files.ts:163-175`):

```ts
await addLinkedComponent({
  id: redundantVersionId,          // host version (user's or checkpoint's)
  targetVersionId: officialVersionId,
  targetFileId: officialFileId,
  replaceFileId: redundantFileId,  // omit in B.1a (no row exists yet)
  componentType,                   // inferComponentType(redundantFile.type)
  modelId: officialModelId,
  modelName: officialModelName,
  versionName: officialVersionName,
  isRequired: true,
  userId: OFFICIAL_USER_ID,        // constants.system.officialUserId (12042163)
  isModerator: true,               // bypasses the referenced-file owner check
});
```

`isModerator: true` is required in B.1b/B.2 because the referenced (official) file is owned by the
official account while the host version belongs to a different user — the ownership guard
(`model-version.service.ts:2112`) would otherwise 403.

### 1.3 New shared service helpers

Add to `src/server/services/model-file.service.ts`, scoped to `constants.system.officialUserId`:

- **`findOfficialFilesBySize(sizeKB: number, fileType: string): Promise<{ id: number }[]>`**
  — backs the B.1a size gate. `ModelFile.sizeKB` is KB-rounded, so this is a loose pre-filter (a few
  false collisions → a few extra hashes), never a positive match on its own.
- **`findOfficialFileByHash(sha256: string): Promise<OfficialFileMatch | null>`**
  — backs B.1a confirm, B.1b, and B.2. Lowercase-join `ModelFileHash` on `type = 'SHA256'`, scope to
  official-owned, **exclude primary `Model`/`Pruned Model` types**, prefer lowest version id on ties.
  Returns `{ versionId, fileId, fileType, modelId, modelName, versionName, fileName, sizeKB }` — the
  exact shape `addLinkedComponent` + the client `LinkedComponent` model need.

Both are plain `dbRead` queries (raw SQL or Prisma). The SHA256 join shape mirrors
`retroactive-hash-blocking.ts:11-18` and the A.2 backfill CTE.

---

## 2. B.1a — client prevent-the-upload

**Goal:** when a user adds a component file whose bytes already exist on the official account, never
upload the bytes — create a linked-component pointer to the official file instead. **No opt-in**
(policy confirmed).

### 2.1 Why the intercept point works

In `FilesProvider.handleUpload` (`FilesProvider.tsx:551`) the order is: `upload()` sends the bytes to
S3 **first**, and only its `onComplete` callback calls `createFileMutation` (`:604`) to insert the
`ModelFile` row. So **at the start of `handleUpload`, no S3 object and no `ModelFile` row exist yet.**
Intercepting there means an early return with **nothing to delete** — no `replaceFileId`, no orphaned
bytes.

### 2.2 Flow (start of `handleUpload`, before `upload()`)

1. **Size gate (instant, no hashing).** `file.size` is known. Call
   `trpc.modelFile.findOfficialFilesBySize({ size, type: chosenType })` (new query, §5). Empty →
   `return` to normal upload; never hash. Eliminates hashing for ~all unique large checkpoints.
2. **Hash (only on size collision).** Compute **full-file SHA256** in a **Web Worker** via `hash-wasm`,
   streaming `file.slice` in **16 MB chunks** (read → hash → discard) so memory stays flat at any file
   size. Optional CRC32 first-chunk early-out. **Safety cap** the worker hash at a named const
   `OFFICIAL_MATCH_HASH_MAX_BYTES = 5 GB` and let B.1b reclaim anything larger server-side (see
   §2.4).
3. **Confirm.** `trpc.modelFile.findOfficialFileByHash({ sha256 })`. No match → normal upload.
4. **On match — skip upload, create pointer.** Do **not** call `upload()` or `createFileMutation`.
   Instead reuse the existing client mutation (`FilesProvider.tsx:214`):
   ```ts
   const result = await addLinkedComponentMutation.mutateAsync({
     id: versionId,
     targetVersionId: match.versionId,
     targetFileId: match.fileId,
     componentType: inferComponentType(chosenType),
     modelId: match.modelId,
     modelName: match.modelName,
     versionName: match.versionName,
     isRequired: chosenIsRequired ?? true,
   });
   ```
   Then push `result` into `linkedComponents` (`setLinkedComponents`, same enrichment as `:224-237`)
   and remove the pending file from `files`. Surface a small note on the card: _"Linked to official
   {modelName} — upload skipped."_

### 2.3 New client pieces

- `src/workers/file-hash.worker.ts` (+ a `useFileHash` hook) — single streaming pass over `file.slice`
  chunks feeding `hash-wasm` SHA256 (CRC32 optional). Output hex lowercased. Validate the digest
  **once** against a known file's stored SHA256 before trusting it.
- Wire the two-gate check into `handleUpload`. Keep it isolated (a small `checkOfficialMatch(file,
  type)` helper) so the upload path stays readable.

### 2.4 Cost profile & why 20 GB

Chunked-streaming reads keep worker memory **flat regardless of file size** — the cap is not about
memory or crashing the client, only about bounding CPU time. Hashing only fires on a size collision
with an official file, and `findOfficialFileByHash` excludes primary weights → only **component
files** can ever collide (VAE/CLIP are MB–GB; text encoders run larger). hash-wasm SHA256 runs
~300–800 MB/s in-browser. **Cap = 5 GB** (conservative): covers VAE/CLIP and mid-size encoders on the
client; large text encoders (T5XXL ~9 GB, umT5 ~11 GB) exceed the cap and are reclaimed by B.1b
server-side after scan instead of prevented up front. B.1b is the backstop, so nothing is missed — the
cap only shifts the biggest files from prevent-upload to post-scan-reclaim.

---

## 3. B.1b — server post-scan safety net

Catches whatever B.1a misses: size-capped files, older clients, races.

In `applyScanOutcome` (`model-file-scan.service.ts:118`), **after** the hash rows are written
(`:194-204`):

1. Guard: `outcome.hashes?.SHA256` present; the file's version is **not** official; the file type is
   **not** primary weights.
2. `const match = await findOfficialFileByHash(outcome.hashes.SHA256)`. No match → done.
3. Match → `addLinkedComponent({ id: file.modelVersionId, targetVersionId: match.versionId,
   targetFileId: match.fileId, replaceFileId: fileId, componentType:
   inferComponentType(uploadedFileType), modelId/modelName/versionName: match, isRequired: true,
   userId: OFFICIAL_USER_ID, isModerator: true })`. Converts the just-uploaded row to a pointer +
   reclaims bytes.

Wrap in try/catch + `logToAxiom` (like the rest of the function) so a dedup failure never breaks scan
finalization. Fetch the uploaded file's `type` (need it for `inferComponentType` and the
primary-weights guard) — extend the `file` select at `:121-128`.

---

## 4. B.2 — official-uploads reclaim job

New `src/server/jobs/dedupe-official-uploads.ts`, registered in the run-jobs array
(`src/pages/api/webhooks/run-jobs/[[...run]].ts:106`). **Cron: hourly.** Template = `scan-files.ts:25`
(batch-select, mark upfront to avoid overlap, `limitConcurrency(…, 10)`).

- **Cursor:** official files whose `ModelFileHash` SHA256 was written since the last run (track a
  `lastRun` timestamp in `sysRedis`, with a small overlap buffer). Idempotency comes from the pointer
  dedupe, so a slightly-overlapping window is safe.
- For each official file's SHA256, find all **other** `ModelFile`s where: different version,
  **not** owned by official, model **published**, type **not** primary weights, no existing pointer
  → the match set (join shape from `retroactive-hash-blocking.ts:11-18` + the A.2 CTE).
- For each match: `addLinkedComponent({ id: matchVersionId, targetVersionId/targetFileId = official,
  replaceFileId: matchFileId, componentType, …, userId: OFFICIAL_USER_ID, isModerator: true })`.
- `limitConcurrency(tasks, 10)`; run **sequentially within a single source version** to avoid the
  check-then-act pointer race the A.2 endpoint documents (`dedupe-official-files.ts:39-44`).
- This is the "retroactive reclaim" the old design punted — tractable because we delete + repoint
  rather than collapse urls.

---

## 5. tRPC surface

`src/server/routers/model-file.router.ts` + `src/server/schema/model-file.schema.ts`:

- `findOfficialFilesBySize` — `guardedProcedure`, input `{ size: number, type: string }`, returns
  `{ id: number }[]`.
- `findOfficialFileByHash` — `guardedProcedure`, input `{ sha256: string }`, returns the match shape
  or `null`.

Both are read-only lookups against official-owned public files → safe for any authed user (they only
ever reveal that an official file of a given size/hash exists, which is public).

---

## 6. Read-path staleness (REQUIRED — A did not ship it; lands in this PR)

B's "rehome onto the official file is safe because it self-heals if official ever deletes it" depends
on stale linked components disappearing. **Verified 2026-07-01: this is not implemented today.** Since
B ships on the same branch as A, this fix also retro-covers A's already-created pointers.

- **Reads do NOT drop stale components.** `model-version.controller.ts:217-236` maps every linked
  `RecommendedResource`; when `linkedFileDataMap.get(s.fileId)` misses (source file deleted) it falls
  back to the denormalized `s.fileName`/`s.versionName` and **still emits the component**
  (`sizeKB`/`fileType` undefined). **Fix:** drop the component when `s.fileId` has no live `ModelFile`
  (or flag `isStale` and hide in the UI). Apply the same in `model.controller.ts` (linked hydration
  around `:203-204, :360-384`).
- **Download.** `file.service.ts:310-331` resolves the linked file by `type: 'Model'` on the linked
  *version* and returns `not-found` (`:333`) when it's gone — so it won't emit a URL for a missing
  file (acceptable). **Two caveats to record, not necessarily fix in B:**
  1. It resolves by `type: 'Model'`, **ignoring `settings.fileId`** — not truly file-granular. Works
     for B's single-file official standalones; would mis-serve a multi-file standalone. If official
     standalones ever carry multiple files, switch this to fetch `settings.fileId` directly.
  2. `findFirst` on `sourceId` + `isLinkedComponent` with no ordering/`fileId` filter grabs an
     arbitrary linked component before the `componentType` check — latent when a version has several
     linked components. Out of scope for B; note for follow-up.

---

## 7. Non-goals

- No primary-checkpoint / weights dedup (linked-component mechanism only fits accessory files).
- No BLAKE3 / content-addressed store / url-collapse — delete + repoint is enough.
- No opt-in / user prompt on match (policy confirmed: auto-replace).
- No change to the public Meili auto-pick path (A's Official/Mine tabs already cover manual linking).

---

## 8. Testing (Vitest)

- **Helpers:** `findOfficialFileByHash` — official scoping, lowercase match, primary-weights excluded,
  lowest-version tie-break; `findOfficialFilesBySize` — size + type filter, official scoping.
- **B.1b:** scan outcome whose SHA256 matches an official file → pointer created + uploaded row
  deleted; non-match → file untouched; uploader is official → skipped; primary-weights type → skipped;
  helper throw → scan still finalizes.
- **B.2:** finds all matching non-official published files → repoints + deletes; idempotent re-run is a
  no-op; respects concurrency; skips primary weights and existing pointers.
- **Read hydration:** a linked component whose `fileId` no longer resolves is dropped on version/model
  reads and yields `not-found` on download.
- **B.1a (worker):** SHA256 of a known fixture matches its stored hash byte-for-byte; size gate returns
  empty → no hashing; match path calls the mutation and not `upload()`.
- **Manual:** as a non-official user, upload a component file byte-identical to an official file →
  confirm no S3 object created and the component shows as linked to official; then delete the official
  source file → confirm the component is hidden on reads and download 404s (never serves wrong bytes).

---

## 9. File-by-file change list

**Shared**
- `src/server/services/model-file.service.ts` — `findOfficialFilesBySize`, `findOfficialFileByHash`.
- `src/server/routers/model-file.router.ts`, `src/server/schema/model-file.schema.ts` — expose both.

**B.1a**
- `src/workers/file-hash.worker.ts` + `useFileHash` hook — streaming SHA256 (CRC32 optional).
- `src/components/Resource/FilesProvider.tsx` — two-gate `checkOfficialMatch` at the top of
  `handleUpload`; on match, create pointer + convert pending file to a linked component.

**B.1b**
- `src/server/services/model-file-scan.service.ts` — post-hash official-match → `addLinkedComponent`
  (+ extend the `file` select to include `type`).

**B.2**
- `src/server/jobs/dedupe-official-uploads.ts` (new) + register in
  `src/pages/api/webhooks/run-jobs/[[...run]].ts`.

**Read-path staleness**
- `src/server/controllers/model-version.controller.ts`, `src/server/controllers/model.controller.ts`
  — drop linked components with an unresolved `settings.fileId`.
