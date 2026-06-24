# Link Existing Files into a Model Version — Design

_Date: 2026-06-24_

_Origin: ClickUp [868k376wr](https://app.clickup.com/t/868k376wr) "Dedupe model files by hash in
'Link to existing model'" (subtask of the model-wizard feedback epic 868k336b9). The task had no
written detail — this doc is the worked-out version. The team's framing was **dedupe by hash**;
this design treats the content hash as the **identity/matching layer** on top of the linked-component
pointer mechanism (see "Hash as the dedup identity")._

## Problem

When a creator needs the same accessory file on multiple versions/models — the canonical case is
the **CivitaiOfficial** account re-uploading the same VAE as an additional component across many
official checkpoints — today the only options are:

1. Re-upload the file → a new `ModelFile` row + a new S3 object → **duplicated byte storage** and
   wasted upload time/bandwidth.
2. Use **"Link to Existing Model on Civitai"** (`Files.tsx:427`), which opens the Meilisearch
   resource picker. This links a whole **published model version**, the server **auto-picks one
   file** from it, and the result is stored as a pointer (no byte duplication). But it can't reach
   the file the creator actually wants, because:
   - it selects a **version**, not a **file** — the creator can't choose which file;
   - it only surfaces **public, Meili-indexed** resources — a VAE that lives as an
     *additional-component file inside another checkpoint* isn't independently selectable;
   - it's semantically a *dependency / recommended resource*, not a file "of this version".

We want a creator to link a **specific file they've already uploaded** into a version, without
re-uploading the bytes.

## Decisions (agreed during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Link semantics | **Linked dependency (Approach A)** — extend the existing `RecommendedResource` linked-component system to file granularity. | Matches the existing model; no new storage abstraction. The pointer references the source file's single S3 object, so no bytes are duplicated. |
| Source scope | **Own files only** | Covers the CivitaiOfficial case; simplest auth (`file.model.userId === ctx.user.id`). Public files remain linkable through the existing Meili version picker. |
| Source-file deletion policy | **Allow delete, links go stale (detected on read)** | Simpler delete UX; no refcount-of-pointers guard. Read paths already fetch the source `ModelFile` by `settings.fileId`, so a missing row is detected almost for free and the link is hidden/flagged. |

### Why not the alternatives
- **Approach B (new `ModelFile` row sharing the S3 object)** would make the file a *native* file of
  the version. Rejected: the creator wants dependency semantics, and B duplicates row-level metadata
  / scan state and complicates the file list.
- **Approach C (content-addressed blob table)** is full dedup with refcounting. Rejected as
  over-engineering — A already removes the re-upload and the duplicate object.

## Current system (what we build on)

- **`RecommendedResource`** (`prisma/schema.prisma:1105`): `resourceId` = the **linked/source**
  version (named confusingly — in `addLinkedComponent` it is set to `input.targetVersionId`),
  `sourceId` = the version being edited, `settings` JSON. **No unique constraint** (indexes only),
  so multiple rows for the same `(sourceId, resourceId)` with different `settings.fileId` are
  already legal at the DB layer.
- **`linkedComponentSettingsSchema`** (`model-version.schema.ts:302`) already pins a specific file:
  `{ isLinkedComponent, componentType, fileId, modelId, modelName, versionName, fileName,
  isRequired }`. **The persistence layer is already file-granular** — the gap is entirely in the
  picker and the add mutation.
- **`addLinkedComponent`** (`model-version.service.ts:2009`): queries all files of
  `targetVersionId` and **auto-picks the primary** by `modelFileOrder`; dedupes by
  `(sourceId, resourceId)`.
- **Read/hydration** already batch-fetches the source `ModelFile` by `settings.fileId` and falls
  back to the denormalized `fileName` when absent:
  - `model-version.controller.ts:193-236`
  - `model.controller.ts:203+`
  - download path: `file.service.ts:315`
- **Client** (`FilesProvider.tsx`, `Files.tsx`): linked components are keyed/deduped by
  **`versionId`** (`removeLinkedComponent(versionId)`, `excludeIds`, the
  `filter(c.versionId !== …)` in `addLinkedComponent`).
- **Storage GC** (`s3-utils.ts:230` `deleteModelFileObject` → `urlsSafeToDelete`): refcounts by
  `ModelFile.url` only. `RecommendedResource` pointers do **not** participate — this is the source
  of the staleness behavior, which we accept by decision.
- **`ModelFileHash`** (`prisma/schema.prisma:1116`): per-file content hashes, types incl.
  **SHA256** (strong content hash) and **AutoV2** (model identity), indexed by `hash`. Written by
  the **scanner** (`model-file-scan.service.ts:202`), *after* upload — so already-uploaded files
  reliably have hashes; a freshly-dropped file does not until it is scanned.

## Hash as the dedup identity

The team's framing (ClickUp 868k376wr) is "dedupe by **hash**". Hash and the linked-component
pointer are **complementary, not competing**:

| Layer | Provided by | Role |
|---|---|---|
| Dedup **mechanism** | linked-component pointer (Approach A) | references the source file's single S3 object — no bytes copied |
| Dedup **identity** | `ModelFileHash.SHA256` | recognizes that two `ModelFile` rows are the same blob |

The pointer is *how we avoid a second object*; the hash is *how we recognize it's the same file*.
Two ways the design uses it:

1. **Picker grouping (in scope, cheap).** `getOwnFilesForLinking` groups the caller's files by
   SHA256 so the user sees each unique file **once** (with the list of versions it already lives
   in), instead of N near-identical rows. This is the literal "dedupe by hash in the link UI".
2. **On-drop auto-suggest (phase 2, more expensive).** When a file is dropped in the wizard,
   SHA256 it client-side and look up `ModelFileHash`; if the caller already has that blob, offer
   "you've already uploaded this — link instead of re-uploading?". Needs full-file hashing in the
   browser because the incoming file isn't scanned yet (the wizard already reads file headers for
   precision/quant inference, so the plumbing exists; the cost is hashing the whole file).

### Forward-only — the load-bearing caveat
This design dedupes **going forward**: linking never creates a second object, so new duplicates are
prevented. It does **not** retroactively merge blobs that are *already* duplicated. Two files
uploaded separately share a SHA256 but have **different `url`s** (different S3 keys), and the GC
refcounts by `url`, not hash — so it will never collapse them. Reclaiming already-wasted bytes is a
separate effort: a backfill that rewrites duplicate rows onto one `url`, or true content-addressed
storage (**Approach C**). Both are out of scope here. → see "Open question for the team".

## Design

No Prisma schema change. Five focused changes.

### 1. Mutation — accept an explicit file (`model-version.service.ts` / `…schema.ts`)
- Add optional **`targetFileId`** to `addLinkedComponentSchema`.
- In `addLinkedComponent`:
  - If `targetFileId` is provided: fetch **that** file (with its model owner) and use it directly
    instead of auto-picking. **Authorize**: the file's `modelVersion.model.userId` must equal the
    caller (`input.id` already passes the `isOwnerOrModerator` middleware for the version being
    edited; the new check guards the *referenced* file). Reject with `FORBIDDEN` otherwise.
  - If absent: keep today's auto-pick-primary behavior (the public Meili path is unchanged).
  - **Dedupe key** becomes `(sourceId, resourceId, settings.fileId)` so two different files from the
    same source version no longer overwrite each other. (The existing `findFirst` on
    `(sourceId, resourceId)` must add a `settings.fileId` match.)
- `targetVersionId` is still required (it's the `resourceId` stored on the row and the
  download-URL anchor); for the own-files picker it's the parent version of the chosen file.

### 2. New query — "my uploaded files" (`model-version.service.ts` + router + schema)
- New `guardedProcedure` `modelVersion.getOwnFilesForLinking` (or `modelFile.getOwnForLinking`).
- Input: `{ baseModel?: string; componentTypes?: ModelFileComponentType[]; search?: string;
  excludeFileIds?: number[]; cursor/limit }`.
- Returns the caller's files (`model.userId === ctx.user.id`) with: `fileId`, `name`, `sizeKB`,
  `type`, inferred `componentType`, parent `versionId`/`versionName` (+ its `baseModel`),
  `modelId`/`modelName`, and the file's **SHA256**.
- **Dedupe by SHA256**: collapse the caller's identical blobs to one entry (joined to
  `ModelFileHash` where `type = 'SHA256'`), surfacing the other locations as metadata. The picked
  entry still links by a concrete `fileId` (any one row backing that blob). Files lacking a SHA256
  yet (not scanned) fall back to appearing individually.
- Browsable grouped by model → version → file, searchable. Filter by base-model compatibility
  (component files inherit their parent version's `baseModel`) and by relevant component types;
  exclude already-linked files via `excludeFileIds`.

### 3. Read-path staleness (3 sites)
Apply the **same** rule everywhere a linked component is hydrated: when the source file id is **not**
present in the batch-fetched `ModelFile` map, the source was deleted →
- **Feed/version/model reads** (`model-version.controller.ts`, `model.controller.ts`): drop the
  linked component (or include `isStale: true` and let the UI hide it). Recommend **dropping** on
  public reads so consumers never see a broken component.
- **Download path** (`file.service.ts:315`): **must** skip — never emit a download URL for a missing
  file.

### 4. Client — file-granular picker + dedupe (`Files.tsx`, `FilesProvider.tsx`)
- Add a second entry point beside "Link to Existing Model on Civitai", e.g. **"Link a file you've
  already uploaded"**, opening a new dialog (registered in `dialog-registry`) backed by the query
  from (2). The new dialog passes an explicit `targetFileId` + its parent `targetVersionId`.
- The existing Meili "Link to Existing Model" button is unchanged (public path).
- Switch the client dedupe key from `versionId` → **`fileId`**: `removeLinkedComponent(fileId)`,
  `excludeIds`/`excludeFileIds`, and the `filter` in `addLinkedComponent`. `LinkedComponentCard`
  keying (`key={component.versionId}`) → `key={component.fileId}`.

### 5. Card/display
- `LinkedComponentCard` already renders `Linked: {versionName} → {fileName}`. No structural change;
  optionally show a "source removed" state if a stale link is ever surfaced in an edit context.

## Lifecycle / staleness (consequence of the deletion decision)

- Linking creates a `RecommendedResource` pointer; **no bytes copied** — the source file's single S3
  object is shared by reference.
- Deleting the source file (or its parent model → cascade) frees the bytes via the existing
  url-refcount GC (no other `ModelFile` references the url). Every version that linked it then has a
  dangling `settings.fileId`.
- We **do not** block that delete. Instead every read path treats "source `ModelFile` row missing"
  as stale and hides the component (download path hard-skips). The denormalized `fileName` in
  `settings` is kept only for display in edit contexts.

## Non-goals
- **No retroactive merge of already-duplicated objects.** Existing dupes share a SHA256 but have
  different `url`s; this design does not collapse them (no backfill, no row rewrite).
- No content-addressed/blob dedup (Approach C).
- No cross-user linking of arbitrary private files (public files stay on the Meili path); SHA256
  matching is scoped to the caller's own files.
- On-drop hash auto-suggest is **phase 2**, not part of the initial cut.
- No automatic re-homing/copy-on-delete of bytes.
- No change to the storage GC or the deletion mutations.

## Open question for the team
The task title says "dedupe by hash", which has two readings — confirm which is wanted:
- **Forward-only (this design):** the link flow stops creating *new* duplicate objects; hash makes
  the picker ergonomic. Solves the CivitaiOfficial re-upload pain. ✅ scoped here.
- **Retroactive reclaim:** also collapse the bytes *already* duplicated on S3. Requires a backfill
  (rewrite duplicate `ModelFile.url`s onto one object, hash-matched + refcount-aware) or a move to
  content-addressed storage (Approach C). Bigger, separate effort — **not** covered here.

## File-by-file change list
- `src/server/schema/model-version.schema.ts` — add `targetFileId` to `addLinkedComponentSchema`;
  add input schema for the new own-files query.
- `src/server/services/model-version.service.ts` — branch `addLinkedComponent` on `targetFileId`
  (+ owner authz + 3-part dedupe); add `getOwnFilesForLinking` (SHA256-grouped via `ModelFileHash`).
- `src/server/routers/model-version.router.ts` — register the new query.
- `src/server/controllers/model-version.controller.ts`, `src/server/controllers/model.controller.ts`,
  `src/server/services/file.service.ts` — drop/skip stale linked components when `settings.fileId`
  has no live `ModelFile`.
- `src/components/Resource/FilesProvider.tsx` — pass `targetFileId`; dedupe by `fileId`.
- `src/components/Resource/Files.tsx` — add "Link a file you've already uploaded" entry point +
  card keying by `fileId`.
- `src/components/Dialog/dialog-registry*.ts` + a new `LinkExistingFileModal` component.

## Testing
- Unit (Vitest): `addLinkedComponent` with `targetFileId` — happy path, owner-authz rejection,
  3-part dedupe (two files from one source version coexist).
- Unit: `getOwnFilesForLinking` — owner scoping, base-model + component-type filtering,
  `excludeFileIds`, and **SHA256 grouping** (two identical-hash files collapse to one entry;
  a file with no SHA256 yet still appears).
- Unit: read hydration drops a linked component whose `fileId` no longer resolves; download path
  skips it.
- Manual: as CivitaiOfficial, link a VAE from checkpoint A into version B; confirm no re-upload and
  a single S3 object; delete the source file and confirm B's component is hidden (not 404).
