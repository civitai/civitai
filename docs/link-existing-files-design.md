# Dedupe Model Resources / Link Existing Files — Design

_Date: 2026-06-24 (rev 2026-06-30: expanded from the single "link existing files" task to the
full **Dedupe Model Resources** epic)_

## Origin

This doc now covers the epic **ClickUp [868k69041](https://app.clickup.com/t/868k69041) "Dedupe Model
Resources"** (owner: Koen for the upload side; this design is the *linking/dedupe* side). The epic
has three subtasks, all of which this doc addresses:

| Subtask | ClickUp | Description (verbatim) |
|---|---|---|
| **A. Linking the ecosystem resources** | [868k690c2](https://app.clickup.com/t/868k690c2) | "Maybe in code, maybe in DB" |
| **B. Link to official instead of upload if hash matches** | [868k6917j](https://app.clickup.com/t/868k6917j) | (1) user uploads a file → look for matching hash from official account and connect to that instead. (2) official account uploads → look for all matching hashes and replace them with a link to the official (job). |
| **C. Auto link diffusion models to ecosystem required resources** | [868k692vz](https://app.clickup.com/t/868k692vz) | Display in the model file edit page with the ability to toggle off their display. If they upload a custom VAE/CLIP/etc that overrides the ecosystem values, hide the selection. Display in model details. |

**Division of labor:** Koen uploads the canonical ecosystem resources (creates the models, versions,
uploads the files). This design is the work of *linking* those new canonical resources into the
already-live ecosystem models and *deduping* the files that were uploaded twice.

**Worked example (the canonical case):** the live **Boogu** checkpoint has a VAE uploaded as an
*additional-component file* (copy #1). Koen separately uploads a standalone **Boogu VAE** model that
contains the same VAE (copy #2, the canonical one). We want Boogu's VAE component to become a
**linked component** pointing at the standalone Boogu VAE, and we **delete copy #1** to reclaim its
bytes.

**Sibling task:** [868k376wr](https://app.clickup.com/t/868k376wr) "Dedupe model files by hash in
'Link to existing model'" lives under a *different* epic (the model-wizard feedback epic
868k336b9). It seeded the original version of this doc (the self-serve picker in Subtask A). The two
efforts share the linked-component mechanism; keep them in sync.

## Scope decisions (confirmed)

| Decision | Choice |
|---|---|
| Subtasks in scope | **A, B, and C** (all three) |
| Subtask A delivery | **Both** — a one-off DB backfill for existing official dupes **and** a reusable code path (mutation/picker) for going forward |
| What happens to the duplicate file after linking | **Remove it (reclaim bytes)** — delete the redundant `ModelFile` row; its S3 object is GC'd by the existing url-refcount path |
| Link semantics | **Linked component (Approach A)** — extend the existing `RecommendedResource` linked-component system to file granularity. No new storage abstraction; the pointer references the canonical file's single S3 object. |
| Source/identity | **SHA256** content hash is the dedup identity; the linked-component pointer is the dedup mechanism. |

### Why byte-reclaim is simple here (correction to the old non-goal)

The previous revision listed "no retroactive merge of already-duplicated objects" as a non-goal,
fearing it required collapsing two different `url`s onto one object with refcount-aware rewrites.
**That harder problem does not apply to this design.** Here we don't collapse urls — we *delete the
duplicate row entirely* and repoint to the canonical file:

- The redundant additional-component file and the canonical official file have the **same SHA256**
  but **different `url`s** (separate uploads → separate S3 keys).
- After creating the linked-component pointer to the **canonical** file, we `deleteFile()` the
  **redundant** row. `urlsSafeToDelete` (`src/utils/s3-utils.ts:195`) sees no other `ModelFile`
  referencing the redundant url and reclaims the bytes. The canonical file (its own row, its own
  url) is untouched.
- `RecommendedResource` pointers do **not** participate in url-refcount GC (the GC reads only
  `ModelFile.url`; the pointer stores `settings.fileId`), so the pointer neither protects nor
  endangers any object. Verified at `src/utils/s3-utils.ts:195-217`.

So "reclaim bytes" = create pointer to canonical, then delete the redundant `ModelFile`. No
url-sharing, no content-addressed store, no refcount rewrite.

## Current system (what we build on)

- **`RecommendedResource`** (`prisma/schema.prisma:1105`, `settings` JSON at `:1111`): `resourceId`
  = the **linked/canonical** version, `sourceId` = the version being edited, `settings` JSON. No
  unique constraint (indexes only), so multiple rows for the same `(sourceId, resourceId)` with
  different `settings.fileId` are legal at the DB layer.
- **`linkedComponentSettingsSchema`** (`src/server/schema/model-version.schema.ts:304-313`) already
  pins a specific file: `{ isLinkedComponent: literal(true), componentType, fileId, modelId,
  modelName, versionName, fileName, isRequired? }`. **The persistence layer is already
  file-granular.** Input schema `addLinkedComponentSchema` at `:333-341`.
- **`addLinkedComponent`** (`src/server/services/model-version.service.ts:2075` — *was* `:2009` in
  the old doc; it moved): queries all files of `targetVersionId`, **auto-picks the primary** by
  `constants.modelFileOrder` (`:2089-2093`), upserts a `RecommendedResource` row stamped
  `isLinkedComponent: true` (`:2096`), deduped on `(sourceId, resourceId, isLinkedComponent)`
  (`:2107-2127`). Related: `setLinkedComponents` (`:2036`), `getLinkedVaeIds` (`:2015`).
- **Read/hydration** splits linked vs regular recommended resources, batch-fetches the source
  `ModelFile` by `settings.fileId`, falls back to denormalized `fileName` when absent:
  - `src/server/controllers/model-version.controller.ts:185-236`
  - `src/server/controllers/model.controller.ts:203-204, 360-384`
  - read shape `src/server/schema/model-file.schema.ts:155-170`
  - download path `src/server/services/file.service.ts:315`
  - linked components are **excluded** from generation resources at the cache layer
    (`src/server/redis/caches.ts:467-469`, `src/server/redis/resource-data.redis.ts:26-28`).
- **Upload + hash pipeline (load-bearing for B):**
  - `createFile()` (`src/server/services/model-file.service.ts:80`) inserts the `ModelFile` row;
    `createFileHandler` (`src/server/controllers/model-file.controller.ts:126`) kicks off the scan
    inline (`:183`).
  - **Hashes are written asynchronously by the scanner**, not at upload: `applyScanOutcome()`
    (`src/server/services/model-file-scan.service.ts:118`) writes `ModelFileHash` rows in a
    delete+createMany transaction (`:194-204`). **At `createFile` time no hash exists yet.**
  - Client-side, the wizard only reads file **headers** (cheap) for precision/quant inference —
    `inferSafetensorsPrecision`/`inferGgufQuantType` (`src/utils/file-helpers.ts:28, :209`, consumed
    in `src/components/Resource/FilesProvider.tsx:536, :542`). **There is no client-side full-file
    content hashing today.**
- **Hash lookup:** no generic "find all `ModelFile`s by SHA256" helper exists. The join pattern is in
  `src/server/services/resource-override.service.ts:14-18` (keyed on `AutoV2`); the SHA256-join shape
  is in the (currently no-op) `src/server/jobs/retroactive-hash-blocking.ts:11-18`. **Hashes are
  stored/compared lowercased.**
- **Storage GC / byte reclaim:** `deleteModelFileObject` (`src/utils/s3-utils.ts:230`) →
  `urlsSafeToDelete` (`:195`) refcounts by `ModelFile.url` only — a url is safe to delete iff no live
  `ModelFile` row references it (`:198-201, :213-216`). The delete service `deleteFile()`
  (`src/server/services/model-file.service.ts:186`) does `DELETE ... RETURNING url` (`:222-235`) then
  fires `deleteModelFileObject(row.url)` best-effort (`:247-258`); it refuses to delete `Training
  Data` files while the model is Draft/Training (`:215-220`) — component files are unaffected.
- **`ModelFileHash`** (`prisma/schema.prisma:1116`): per-file hashes incl. **SHA256** (full-file
  content identity — use this for byte dedup) and **AutoV2** (model-weights identity). Indexed by
  `hash`.
- **Jobs:** `createJob(name, cron, fn, options)` (`src/server/jobs/job.ts:54`); jobs are registered by
  import into the array in `src/pages/api/webhooks/run-jobs/[[...run]].ts:106`. Closest template for a
  batch file job: `scanFilesFallbackJob` (`src/server/jobs/scan-files.ts:25`) — batch-select, mark
  upfront to avoid overlap, `limitConcurrency(..., 10)`.
- **The "official" account is NOT encoded in the repo.** There is only the *system* user
  (`constants.system.user` = id `-1`, username `civitai` — `src/server/common/constants.ts:351-352`),
  which is the system *actor*, not the public CivitaiOfficial content account. **The public
  CivitaiOfficial account is `userId = 12042163`** (confirmed by the team). Add it as a named constant
  (e.g. `constants.system.officialUserId` / `CIVITAI_OFFICIAL_USER_ID`) — A.2 backfill, B.1 lookup,
  and B.2 job all scope on it.

---

## Subtask A — Linking the ecosystem resources (868k690c2)

Link Koen's canonical standalone resources into the live ecosystem checkpoints as linked components,
removing the redundant additional-component files. Delivered **two ways**.

### A.1 Code path (reusable, going-forward)

Extend the existing self-serve link flow to file granularity + dedup.

1. **Mutation accepts an explicit file** (`model-version.service.ts` / `…schema.ts`)
   - Add optional **`targetFileId`** to `addLinkedComponentSchema`.
   - In `addLinkedComponent`: if `targetFileId` present, fetch **that** file (with its model owner)
     and use it directly instead of auto-picking the primary. **Authorize**: the referenced file's
     `modelVersion.model.userId` must equal the caller (the existing `isOwnerOrModerator` middleware
     only guards the version being *edited*, not the *referenced* file). Reject `FORBIDDEN`
     otherwise. If absent, keep today's auto-pick-primary behavior (the public Meili path is
     unchanged).
   - **Dedupe key** becomes `(sourceId, resourceId, settings.fileId)` so two different files from the
     same source version coexist.
2. **Optional dedup of the local duplicate.** Add an optional `replaceFileId` (the redundant
   additional-component file in the *edited* version): after the pointer is created, `deleteFile()`
   that row to reclaim bytes. Guard: `replaceFileId` must belong to `input.id` (the edited version)
   and must not be the version's only/primary model file.
3. **Picker query** — `modelVersion.getOwnFilesForLinking` (`guardedProcedure`): returns the
   caller's files (`model.userId === ctx.user.id`) with `fileId, name, sizeKB, type, inferred
   componentType, parent versionId/versionName (+ baseModel), modelId/modelName, SHA256`. **Dedupe by
   SHA256** (join `ModelFileHash` where `type = 'SHA256'`, lowercased) so identical blobs collapse to
   one entry; files not yet scanned (no SHA256) appear individually. Filter by base-model
   compatibility + relevant component types; exclude already-linked via `excludeFileIds`.
4. **Client** (`src/components/Resource/Files.tsx`, `FilesProvider.tsx`): add a second entry point
   beside "Link to Existing Model on Civitai" — **"Link a file you've already uploaded"** — opening a
   new dialog (registered in `dialog-registry`) backed by (3). It passes explicit `targetFileId` +
   parent `targetVersionId` (+ optional `replaceFileId`). Switch the client dedupe key from
   `versionId` → **`fileId`** (`removeLinkedComponent(fileId)`, `excludeFileIds`, the `filter` in
   `addLinkedComponent`, `LinkedComponentCard` `key`). The existing Meili button is unchanged.

### A.2 DB backfill (one-off, existing official dupes)

A temp admin endpoint (per project convention these live in **`src/pages/api/admin/temp/`**, guarded
by `WebhookEndpoint`, scoped per-call — *not* `api/testing`).

- Scope to the **official account userId** (open question).
- For each official checkpoint version with additional-component files (VAE/CLIP/TextEncoder/…) whose
  **SHA256 matches a file in a standalone official model version**:
  1. Create the `RecommendedResource` linked-component pointer: edited (checkpoint) version →
     standalone version's file (`componentType` from `inferComponentType`,
     `src/server/utils/model-helpers.ts:283`).
  2. `deleteFile()` the redundant additional-component `ModelFile` (reclaim bytes).
- **Idempotent:** skip if a pointer with that `(sourceId, resourceId, fileId)` already exists; skip
  files whose row is already gone. Dry-run mode that reports candidate pairs before mutating.

---

### A — implementation status (2026-06-30)

**Scope change — the self-serve own-files picker was CUT.** Querying the caller's files by
`model.userId` (`getOwnFilesForLinking`) reached their **draft / unpublished / unscanned** files, and
the download path serves a linked component's source file **without re-checking the source's status**
(`file.service.ts:252` gates only the *host* version; `:312-330` serves the linked source with no
status/scan check). Linking a draft file into a published "safe" model would distribute unmoderated
content — a moderation bypass. The only thing the picker safely added is already covered: own
*published* models via the Meili **Mine** tab (index = published = moderated), and official-file
matches via **Subtask B**.

**Replacement (shipped):** two changes to the existing Meili "Link to Existing Model" picker, both
scoped to `selectSource === 'modelVersion'` so the generation picker is unaffected
(`useResourceSelectFilters.ts` / `ResourceSelectModalContent.tsx`):
- relax the **Mine** tab — a creator can pick any of their own *published* component models regardless
  of base-model match (`skipBaseModel` on `mine`);
- add an **Official** tab — surfaces the CivitaiOfficial canonical resources
  (`user.id = constants.system.officialUserId`) at link time, base-model-relaxed. This is the manual,
  self-serve nudge to link the official VAE/encoder instead of re-uploading — the complement to
  Subtask B's auto-link-on-hash-match. Safe because official models are published.

  **Two base-model filters must both be relaxed** for these tabs: the Meili query
  (`useResourceSelectFilters.ts`, `skipBaseModel`) *and* the client-side per-version filter
  (`ResourceHitList.tsx` `filterVersions`) — otherwise Meili returns the official models but every
  version is stripped client-side → "No models found".

**Kept (built + TDD, not committed):**
- **Schema** (`model-version.schema.ts`): `targetFileId` + `replaceFileId` on `addLinkedComponentSchema`.
- **Service** (`model-version.service.ts`): `addLinkedComponent` branches on `targetFileId` (+ owner
  `FORBIDDEN` authz + 3-part dedupe on `(sourceId, resourceId, fileId)` + validated
  `replaceFileId`→`deleteFile` byte reclaim; auto-pick path unchanged). Used by A.2 + needed by
  Subtask B. `inferComponentType` exported from `utils/model-helpers.ts`.
- **Router**: threads `userId`/`isModerator` into `addLinkedComponent`.
- **Constant**: `constants.system.officialUserId = 12042163`.
- **A.2 backfill**: `src/pages/api/admin/temp/dedupe-official-files.ts` (dryRun default), reuses `addLinkedComponent`.
- **Tests**: 16 passing (mutation happy/authz/mod/not-found/dedupe-per-file/update/replace-guards/auto-pick + idempotent regression).

**Removed:** `getOwnFilesForLinking` (service/schema/router), `utils/linkable-files.ts`,
`OwnFilesLinkPanel`, `LinkComponentModal`, the `link-component`/`link-existing-file` triggers, and the
`FilesProvider` `linkExistingFile` / `versionId→fileId` changes (reverted to HEAD).

**A.2 matching — validated against prod (2026-06-30):** `redundant` = a component file
(VAE / Text Encoder / ControlNet) bundled in a model whose `Model.type` is NOT the dedicated type;
`canonical` = the same SHA256 blob in a model whose `Model.type` IS the dedicated type
(VAE→VAE, Text Encoder→TextEncoder, ControlNet→Controlnet). The query returns **5 current pairs** —
the **Z Image** Base/Turbo checkpoints bundle the Flux VAE (→ standalone **Flux.1-AE**) and the Qwen3
text encoder (→ standalone **Qwen3 4b**). It deliberately excludes the noise: a blob shared across
sibling checkpoints (no standalone) and Config files shared across ControlNets are left untouched.
Still run `dryRun=true` before apply. (DB requires `NODE_TLS_REJECT_UNAUTHORIZED=0` locally — the
replica presents a self-signed cert.)

## Subtask B — Link to official instead of upload if hash matches (868k6917j)

Two directions. Both reuse the A.2 primitive (create pointer to canonical official file + delete the
redundant row).

### B.1 User uploads → match official → link instead

**Chosen: prevent the upload via a client-side staged hash match.** The team wants the bytes to never
hit storage when an official copy already exists. The server-side hash isn't known until the scanner
runs (`applyScanOutcome:194`), *after* the upload — so the match must be computed **client-side,
before `uploadToS3` sends any bytes**.

#### Identity: byte-match, not weights-match

We store six hash types (`ModelHashType`: `AutoV1, AutoV2, AutoV3, SHA256, CRC32, BLAKE3`), and they
do **not** all measure the same thing. Skipping the upload makes the user's model serve the
**official file's exact bytes**, so the green light requires **byte identity**, not weights identity:

| Hash | Proves | Range | Green-light to skip upload? |
|---|---|---|---|
| **SHA256** | byte identity (if full-file — see verify item) | full file | ✅ definitive |
| **BLAKE3** | byte identity | full file | ✅ definitive |
| **CRC32** | weak 32-bit checksum (easy collisions) | full file | ⚠️ negative pre-filter only |
| **AutoV2 / AutoV3** | **weights** identity, metadata-independent | header-skipped | ❌ same weights ≠ same bytes |
| **AutoV1** | legacy partial | 64KB @ 1MB offset | ❌ partial |

So **do not "match as many as possible to be sure"** — that conflates two different identities. An
AutoV2 match means *same weights, possibly different metadata header → different bytes*; linking on
it would serve the official's file in place of the user's, which differs. CRC32 is too weak to trust
positively. The decision to skip the upload must rest on **one strong full-file hash (SHA256 or
BLAKE3)**. Computing the cheaper ones is still useful — as fast rejects, and as a fallback to whatever
the official file actually has recorded — but never as the sole positive match.

#### Staged match (cheap → definitive), all in one streaming pass

A Web Worker keeps this off the main thread (no UI freeze). Hook point: the start of `uploadToS3`
(`src/hooks/useS3Upload.tsx:164`), or `FilesProvider` just before it. Before the `/api/upload`
part-URL request:

1. **Size gate (instant).** `file.size` is already known. Query
   `findOfficialFilesBySize(size, type)`. No official file of this exact size → **definitely not a
   dup → upload normally, never hash.** Eliminates client hashing for ~all unique 20GB+ checkpoints.
   (`ModelFile.sizeKB` is KB-rounded, so collisions are a touch looser → slightly more confirmations,
   still rare, still safe. Store exact bytes later if we want tighter gating.)
2. **Cheap reject (only on size collision).** In the worker, single pass over `file.slice` chunks,
   feed every chunk into incremental **CRC32** + **SHA256** + **BLAKE3** at once (one disk read, N
   hashers). CRC32/first-chunk can early-out the comparison, but since we're already streaming we just
   compute the strong hash too.
3. **Definitive (full-file SHA256 / BLAKE3).** Match an official file → byte-identical → **skip the
   upload entirely** and create the linked-component pointer to the official file. No `ModelFile`/S3
   object is ever created.

Each non-SHA256 algorithm (CRC32, AutoV1, AutoV2's header-skip) must be replicated **byte-for-byte**
to match the orchestrator's stored value; validate each once against a known file. SHA256/BLAKE3/CRC32
have JS/WASM libs (`hash-wasm`); AutoV2's header-skip reuses the safetensors header parsing we already
do (`inferSafetensorsPrecision` reads the 8-byte header length, `file-helpers.ts:28`). Output hex,
lowercased, to match (`ModelFileHash` stores lowercased).

#### Cost profile

Expensive hashing happens **only on a size collision with an official file** — rare. The real dedup
targets (VAE/CLIP/small TextEncoders) are small and hash in seconds; large T5 encoders (~5–10GB) hash
in ~10–20s in the worker but only when size-matched, and that's still far cheaper than uploading them.
Optionally size-cap the worker hash and let B.1b catch the rest.

#### Verify before building

⚠️ **Confirm what byte range Civitai's stored `SHA256` covers — full file or header-skipped (like
AutoV2).** Defined by the orchestrator/scanner (not in this repo). If it's full-file, it is our
byte-identity key. If it's header-skipped, *no* stored hash is a true full-file byte hash, and we must
add one (compute + store **BLAKE3 full-file** on official files) before relying on it for
object-sharing. For the core case (official re-uploading the *same* exported file) every copy is
byte-identical so it's moot — but confirm before trusting SHA256 as the byte key.

#### Safety net — B.1b (server post-scan)

Keep a server-side fallback for whatever slips past the client check (size-capped-out files, older
clients, races): in `applyScanOutcome`, after the SHA256 is written, if it matches an official file
and the uploader isn't official, convert the just-uploaded file to a pointer and `deleteFile()` the
row. Reclaims storage even when prevention didn't fire.

#### Policy (confirmed)

Auto-replace with a pointer to the official copy — **no opt-in needed**. The user's model depends on
the official file; if official ever deletes it, the read-path staleness rule hides the component
(never 404). Official files are stable, so this is acceptable.

### B.2 Official uploads → job replaces all matching

A cron job (`createJob`, registered in the `run-jobs` array; template `scan-files.ts:25`).

- Cursor over recently-scanned **official** files (those with a fresh `ModelFileHash` SHA256).
- For each official file's SHA256, find all **other** `ModelFile`s (different version, not owned by
  official, published) with the same SHA256 (the `retroactive-hash-blocking.ts:11-18` join shape).
- For each match: create the linked-component pointer (match's version → official version's file) and
  `deleteFile()` the redundant row.
- `limitConcurrency(..., 10)`; mark/skip processed to avoid overlap; idempotent.
- **This is the "retroactive reclaim"** the old doc punted on — but tractable here because we delete +
  repoint rather than collapse urls (see "Why byte-reclaim is simple").
- Policy (confirmed): auto-rehome onto the official file, no opt-in (same as B.1).

---

## Subtask C — Auto link diffusion models to ecosystem required resources (868k692vz)

**This is genuinely new — there is no ecosystem → required-resource data today.** The only
ecosystem-level default is `EcosystemSettings.defaults.model` (a *checkpoint* modelVersionId per
ecosystem — `src/shared/constants/basemodel.constants.ts:54-63, :1063-1075`); no VAE/CLIP/TextEncoder
is pinned anywhere (`requiredResources`/`defaultVae`/etc. return zero matches across `src/`).
Generation handlers consume only a **user-supplied** vae, never an ecosystem-pinned one
(`stable-diffusion.handler.ts:108, :271`).

### C.1 New data: ecosystem → required resources

Add a required-resources map keyed by ecosystem/base-model:
`{ componentType: ModelFileComponentType, modelVersionId, fileId }[]`. Two homes — **"maybe in code,
maybe in DB"**:
- **Constants** (recommended): extend `EcosystemSettings` in `basemodel.constants.ts` (sits next to
  the existing `defaults.model`; versioned, reviewable, no migration).
- **DB**: a small `EcosystemRequiredResource` table if these need to change without a deploy.

### C.2 Auto-populate + override (file edit page)

- `FilesProvider` already receives `baseModel` (`src/components/Resource/FilesProvider.tsx:689`) but
  doesn't use it. Use it to surface the ecosystem's required resources as suggested linked components
  in the **"Additional Components"** section (`Files.tsx:356-437`).
- **Toggle off:** reuse the existing per-file **Required** toggle pattern (`Files.tsx:659-666`,
  persisted to `metadata.isRequired`, `:898`) — add a show/hide toggle for each ecosystem-suggested
  component on this model.
- **Override detection:** if the user uploads a custom component file whose `inferComponentType`
  (`model-helpers.ts:283-305`) resolves to the same `componentType` (e.g. `'VAE'`), hide the
  ecosystem suggestion for that type. `ModelFileComponentType` union: `src/types/global.d.ts:136-147`;
  runtime list `src/server/common/constants.ts:105-117`.

### C.3 Display in model details

Extend the viewer-facing **`RequiredComponentsSection`**
(`src/components/Model/ModelVersions/RequiredComponentsSection.tsx`, rendered from
`ModelVersionDetails.tsx:1077-1094`) to surface ecosystem required resources alongside the existing
required linked components. **Decision** — materialize ecosystem defaults as real `RecommendedResource`
rows (consistent with the pipeline, but stale if the map changes) vs compute them virtually at read
(always fresh, more read-path code). Recommend **virtual/computed at read**, with a user-uploaded
component of the same type taking precedence (the override).

---

## Read-path staleness (applies across A/B/C)

When a linked component's source `ModelFile` (its `settings.fileId`) is **not** present in the
batch-fetched map, the source was deleted → apply the same rule everywhere:

- **Feed/version/model reads** (`model-version.controller.ts`, `model.controller.ts`): **drop** the
  linked component on public reads so consumers never see a broken component (or flag `isStale` and
  let the UI hide it).
- **Download path** (`file.service.ts:315`): **must** skip — never emit a download URL for a missing
  file.

This is what makes B's "rehome onto official's file" safe: if the official source is ever deleted,
every dependent link self-heals to hidden instead of 404-ing.

---

## Non-goals

- **No content-addressed/blob storage** (the old "Approach C"). Delete + repoint is enough.
- **No url-collapse / refcount rewrite.** We delete the duplicate row, not merge two urls.
- No cross-user linking of arbitrary *private* files via the picker (public files stay on the Meili
  path); SHA256 matching is scoped to the caller's own files (A) or the official account (B).
- B's automatic rehoming of *non-official* user uploads is pending the policy decision (see open
  questions) — default to suggest/opt-in.

## Decisions (resolved) & remaining questions

**Resolved 2026-06-30:**
1. ✅ **Official account identity** — public CivitaiOfficial is `userId = 12042163`. Add a named
   constant; A.2 / B.1 / B.2 scope on it.
2. ✅ **B.1 strategy** — **prevent the upload** via client-side full-file SHA256 (B.1a), with
   server post-scan dedup (B.1b) as the safety net. Size-gate client hashing if needed.
3. ✅ **B policy** — auto-replace with a pointer to the official copy, no opt-in.

**Still open (Subtask C, lower urgency):**
4. **C data home.** Ecosystem required-resources map in `basemodel.constants.ts` (recommended) or a
   new DB table?
5. **C materialization.** Real `RecommendedResource` rows for ecosystem defaults vs virtual/computed
   at read (recommended).

## File-by-file change list

**Shared / Subtask A**
- `src/server/schema/model-version.schema.ts` — add `targetFileId` (+ optional `replaceFileId`) to
  `addLinkedComponentSchema`; add input schema for `getOwnFilesForLinking`.
- `src/server/services/model-version.service.ts` — branch `addLinkedComponent` on `targetFileId`
  (+ owner authz + 3-part dedupe + optional `replaceFileId` → `deleteFile`); add
  `getOwnFilesForLinking` (SHA256-grouped via `ModelFileHash`).
- `src/server/routers/model-version.router.ts` — register the new query.
- `src/server/controllers/model-version.controller.ts`, `controllers/model.controller.ts`,
  `services/file.service.ts` — drop/skip stale linked components when `settings.fileId` has no live
  `ModelFile`.
- `src/components/Resource/FilesProvider.tsx` — pass `targetFileId`/`replaceFileId`; dedupe by
  `fileId`.
- `src/components/Resource/Files.tsx` — add "Link a file you've already uploaded" entry point + card
  keying by `fileId`.
- `src/components/Dialog/dialog-registry*.ts` + new `LinkExistingFileModal`.
- `src/pages/api/admin/temp/dedupe-official-files.ts` — A.2 backfill (dry-run + apply).

**Subtask B**
- `src/server/common/constants.ts` — add the official userId constant (`12042163`).
- `findOfficialFilesBySize(sizeKB, type)` + `findOfficialFileByHash(sha256 | blake3)` service helpers
  (new), scoped to the official account — back the size gate, the client confirm query, and the job.
- A worker hashing module (new, e.g. `src/workers/file-hash.worker.ts` + a `useFileHash` hook) —
  single streaming pass over `file.slice` computing CRC32 + SHA256 + BLAKE3 (and AutoV2 header-skip if
  needed) via `hash-wasm`, off the main thread. Each algorithm validated once against a known file.
- `src/hooks/useS3Upload.tsx` (or `src/components/Resource/FilesProvider.tsx`) — before
  `uploadToS3`: size gate → on collision, worker hash → on strong full-file match, skip upload and
  create the linked-component pointer (B.1a).
- `src/server/services/model-file-scan.service.ts` — in `applyScanOutcome`, after SHA256 write,
  detect official-hash match → convert to linked component + `deleteFile` (B.1b safety net).
- `src/server/jobs/dedupe-official-uploads.ts` (new) + register in
  `src/pages/api/webhooks/run-jobs/[[...run]].ts` — B.2 job.
- ⚠️ Verify the byte range of Civitai's stored `SHA256` (full-file vs header-skipped); if
  header-skipped, also compute + store full-file BLAKE3 on official files as the byte-identity key.

**Subtask C**
- `src/shared/constants/basemodel.constants.ts` — ecosystem required-resources map on
  `EcosystemSettings` (or new DB table).
- `src/components/Resource/FilesProvider.tsx` / `Files.tsx` — use `baseModel` to surface ecosystem
  required components + show/hide toggle + override detection via `inferComponentType`.
- `src/components/Model/ModelVersions/RequiredComponentsSection.tsx` /
  `ModelVersionDetails.tsx` — render ecosystem required resources in model details.

## Testing

- **A** (Vitest): `addLinkedComponent` with `targetFileId` — happy path, owner-authz rejection,
  3-part dedupe (two files from one source version coexist); `replaceFileId` deletes the redundant
  row and reclaims bytes. `getOwnFilesForLinking` — owner scoping, base-model + component-type filter,
  `excludeFileIds`, SHA256 grouping (identical-hash files collapse; unscanned file still appears).
- **A.2 backfill**: dry-run lists correct pairs; apply is idempotent (re-run is a no-op).
- **B.1b**: scan outcome whose SHA256 matches an official file converts to a pointer + deletes the
  uploaded row; non-match leaves the file; uploader == official is skipped.
- **B.2 job**: finds all matching non-official files, repoints + deletes, idempotent, respects
  concurrency.
- **C**: ecosystem required resources auto-appear for a matching `baseModel`; a user-uploaded VAE
  hides the ecosystem VAE suggestion; toggle persists.
- **Read hydration**: a linked component whose `fileId` no longer resolves is dropped on reads and
  skipped on download.
- **Manual**: as official, link a VAE from checkpoint A into version B; confirm one S3 object and the
  duplicate reclaimed; delete the source file and confirm B's component is hidden (not 404).
