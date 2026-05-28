# 3D Models Support — Implementation Plan

**Status**: Rev 9 — open questions resolved, ready to implement.
**Author**: AI assistant, with Luis
**Date**: 2026-05-27 (rev 9)
**Project framing**: hackathon pilot / tech demo. v1 ingests 3D models from the orchestrator's PolyGen recipe (Meshy via Fal). User uploads are explicitly OUT of v1 to dodge the moderation/scanning lift, but the data model is upload-ready for future use.

---

## 1. Executive Summary

We're adding a first-class 3D Model content type to Civitai, populated by **AI generation** (PolyGen / Meshy text-to-3D and image-to-3D, via the orchestrator). Users browse a feed, view a 3D model in-browser, see generation details, react to thumbnails (not to the model), discuss in comments, review with stars, and post "Makes/Uses" (e.g. how they used the model in a game).

**Locked architectural calls**:

- **New top-level entity** (`Model3D` + `Model3DFile`). No versioning. A `Model3D` carries its thumbnail, license, and 1..N files (one per format: GLB primary + FBX/OBJ/USDZ alternates).
- **Source = generation, not upload**, in v1. Schema is upload-ready (`workflowId` nullable) so the future upload flow is a code-only change.
- **Generation via `invokePolyGenStepTemplate`** (civitai-client PolyGen). Two operations: `textTo3D`, `imageTo3D`. Engine `fal`, model `meshy`.
- **No `Model3DReaction` table**. Reactions ride on the thumbnail Image (which is itself an `Image` row, reusing `ImageReaction`).
- **No `Model3DDownloadHistory` table**. Download events go to ClickHouse; the per-model rollup is denormalized into `Model3DMetric.downloadCount`.
- **Reviews in scope** — `Model3DReview` parallel to `ResourceReview`, with the `/3d-models/[id]/reviews` route.
- **Thumbnail comes from the generator** (PolyGenOutput.thumbnail). Only the thumbnail Image gets NSFW/CSAM scanned for v1.
- **Routes**: `/3d-models`, `/3d-models/[id]`, `/3d-models/[id]/reviews`.
- **New `Model3DLicense` table** tailored for 3D-asset licensing (printing + games + viz).

**Effort**: Phase 1 (schema + generation panel + save-as-Model3D + detail page + reviews) **L** — honest. Phase 2 (feed + community Posts + makes/uses surfaces) S–M. Phase 3 (user uploads) deferred.

---

## 2. Architectural Decisions

### 2.1 New top-level entity (`Model3D`), no versioning, upload-ready

A printable / game-ready / visualization 3D asset has nothing to do with what Civitai calls a "Model" (an AI inference resource). Separate entity, no `ModelType` extension.

**No versioning** in v1. A `Model3D` is the unit; if someone iterates, that's a new `Model3D`. (Future: easy to add `Model3DVersion` later if real demand emerges.)

**Upload-ready**: `workflowId` and `sourceImageId` are nullable. Today every row will have them set (generation provenance). Tomorrow's user-upload flow writes rows with both NULL. No schema migration needed for that pivot.

### 2.2 Source = orchestrator PolyGen (v1 only)

Integration uses the **async workflow pattern**, not the synchronous template-eval endpoint:

- Submit via `submitWorkflow` with a `PolyGenStep` (`$type: 'polyGen'`) — mirrors `sora.handler.ts` / `wan` exactly. Result streams back via the existing workflow result handler; the user sees a generation card in their queue with status / retry / cost.
- **Do not** call `invokePolyGenStepTemplate` directly (synchronous, bypasses queue/billing/retries).

Two operations on Meshy:

- `MeshyTextTo3dFalPolyGenInput` — prompt → 3D
- `MeshyImageTo3dFalPolyGenInput` — source image URL → 3D

Meshy params surfaced in the form (all from `MeshyFalPolyGenInput`): `targetPolycount` (100–300k, default 30k), `topology` (`quad`|`triangle`), `symmetryMode` (`off`|`auto`|`on`), `shouldRemesh`, `enablePbr`, `texturePrompt`, `enableRigging`, `enableAnimation`, `seed`. Text-to-3D adds `prompt`, `mode` (`preview`|`full`), `enablePromptExpansion`. Image-to-3D adds `imageUrl`, `shouldTexture`.

`PolyGenOutput` returns: `model: Model3dBlob` (primary, e.g. `format='glb'`), `fbxModel?: Model3dBlob` (optional FBX), `thumbnail?: ImageBlob`. The result handler:

1. Ingests the source image (image-to-3D only) as an `Image` row first, mirroring Sora's `sourceImageSchema` pattern, before the workflow submit. The resulting `Image.url` is what goes into `imageUrl`. `Model3D.sourceImageId` references this row.
2. On result, copies returned blobs (`model.url`, `fbxModel?.url`, `thumbnail?.url`) into our S3 (`3d/` prefix). `Model3dBlob.url` is nullable and may need a re-presign — retry on stale URL.
3. Snapshots the full PolyGenInput into `Model3D.generationParams` (Json) — the Generation Details panel reads from here.
4. Creates `Model3DFile` rows (one per format, GLB marked `isPrimary`).

`Model3dBlob.format` is free-string by contract; the result handler normalizes (`toLowerCase().replace(/^\./, '')`) before insert so `"GLB"` / `".glb"` / `"glb"` all hash to the same row.

**Client status**: `@civitai/client@0.2.0-beta.67` (currently installed) exports `submitWorkflow`, `PolyGenStep`, `PolyGenStepTemplate`, `FalPolyGenInput`, `MeshyFalPolyGenInput`, `MeshyTextTo3dFalPolyGenInput`, `MeshyImageTo3dFalPolyGenInput`, `Model3dBlob`. **Unblocked.**

### 2.3 Thumbnail comes from the generator

`PolyGenOutput.thumbnail` is an `ImageBlob`. We save it as a regular `Image` row, scan it through the standard NSFW/CSAM pipeline, then link `Model3D.thumbnailImageId = image.id`.

If `thumbnail` is missing from the output, we fall back to `sourceImage` (for image-to-3D) or a placeholder render. The detail page must always have *something* to show.

The thumbnail Image lives in a Post (per the `Image.postId` FK constraint). The "Post from Generation" CTA creates that Post when the user saves the generation; community Posts ("I used this in my game") are separate Posts linked via `Post.model3dId`.

### 2.4 Viewer → three.js GLB renderer (new component, dynamic-imported)

Primary format is GLB (Meshy default). `three.js` + `GLTFLoader` + `OrbitControls` handles GLB natively, including PBR materials and rigging. Dynamic-imported (`next/dynamic`, `ssr: false`) so the bundle hit is paid only by viewers.

**This is a from-scratch component**, not a rebrand of anything that exists. `three` is not currently in `package.json` — Phase 1 needs to install `three` + `@types/three` and verify bundle delta with `next build`.

**Queue card preview**: do NOT spin up a WebGL context per queue card (5 queued generations = 5 WebGL contexts on the page = bad). Queue cards show the thumbnail Image only; the full viewer instantiates on the detail page click.

Other formats (FBX, OBJ, USDZ, STL) are stored alongside but the in-browser viewer only renders GLB. The "Files" dropdown lets users download any format.

### 2.5 Files → multiple formats per Model3D, dropdown selector

`Model3DFile` rows are 1..N per Model3D, one per `format`. Unique on `(model3dId, format)`. An `isPrimary` boolean marks the default viewer/download format (typically GLB). The detail page renders a single dropdown "Format: GLB / FBX / OBJ" with the primary pre-selected.

**No file size cap in v1.** Storage is not a constraint right now per product direction. Realistically Meshy outputs are 5–50 MB so caps would rarely bite anyway. Revisit if egress costs spike post-launch.

### 2.6 Community Posts ("Makes/Uses") → `Post.model3dId`

Community members create Posts to show how they used a Model3D (e.g. screenshots from a game, renders from Blender). These Posts get `Post.model3dId = <model>.id`. The detail page renders a "Makes & Uses" rail showing these Posts.

The creator's auto-Post (containing the generation thumbnail) and community Posts both live in the `Post` table, differentiated by `userId`.

### 2.7 Licensing → new `Model3DLicense` table

Same as rev 4: separate `Model3DLicense` table with print-farm / derivatives / redistribution flags. Generated content defaults to a "Civitai Generated" license (configurable). Users can change it at "Post from Generation" time.

Seeded templates: CC-BY 4.0, CC-BY-NC 4.0, Personal Use Only, No Commercial Print Farm, All Rights Reserved, Custom.

### 2.8 Tag taxonomy → generic 3D-asset tags

Not print-specific. Seeds:

- **Subject** (categories): character, creature, environment, prop, vehicle, architecture, furniture
- **Style** (filters): low-poly, stylized, realistic, abstract, sci-fi, fantasy

Print-specific tags (FDM, Resin, Supports Required, Print-in-Place, etc.) are dropped — the goal is to be 3D-generic, not print-focused.

### 2.9 Discovery / search → dedicated `model3d` Meilisearch index

A new index. Lots of wiring (new instantsearch tab, new parser, separate reindex cron) but clean separation.

### 2.10 NSFW scanning + mod tooling → thumbnail Image is the single signal

The 3D model file itself is NOT scanned for content (mod team has no tooling for 3D content moderation). We rely on:

- **Generator-provided thumbnail** flowing through the standard `Image` NSFW + CSAM scan pipeline.
- **PolyGen `allowMatureContent` query param** to gate generation by user moderation level.
- **Mod team review queue** for reports.

**Mod tooling — basic, thumbnail-driven**: when a moderator actions a thumbnail Image (block, NSFW level change, delete), they get a "Also action the parent Model3D" affordance on the existing image-mod page. Action propagates: delete thumbnail → Model3D goes to `Unpublished` (or `Deleted` if mod chooses); NSFW level change → propagated by the `updateModel3DNsfwLevels` batch job (§4). No 3D-specific mod queue in v1.

Future user uploads will need real 3D content moderation; that's a Phase 3 problem.

### 2.11 Entry point + feature flags → split feed / generator flags

**Two Flipt flags, both mod-only at launch**:

- `model3d-feed` — gates *viewing*: feed page, detail page, comments, reviews, profile tab. If you have feed access you can browse existing Model3Ds, comment, react, review — but you cannot create.
- `model3d-generator` — gates *creating*: the new "3D Model" segmented option in the generation panel. Implies `model3d-feed` (no point in generation if you can't see results).

Both flipt-config'd; mod-only to start, opened to broader audiences when QA + content seeding catches up.

The generation panel today (`src/components/ImageGeneration/GenerationForm/GenerationForm.tsx`) has segmented controls for Image and Video. With `model3d-generator` on, we add a third: **3D Model**. The form has two sub-tabs: text-to-3D and image-to-3D.

Result handling follows the established pattern (`GeneratedImageActions.tsx`):

1. Workflow completes; queue card shows the generation's **thumbnail Image** (not an inline viewer — see §2.4).
2. User clicks "Post from Generation" → mutation creates an empty `Post`, redirects to `/posts/[postId]/edit`.
3. On the edit page, the user fills in `Model3D` metadata (name, description, tags, license) — same edit page hosts both Post fields and Model3D fields, since they're created together.
4. On publish: `Model3D.status = Published`, `Post` flipped to public, `Post.model3dId` set.

The Model3D row itself is created at the time the workflow result handler runs (server-side, on completion), in `Draft` status, tagged with `workflowId`. `workflowId` is UNIQUE — re-submitting the "Post from Generation" CTA returns the existing draft instead of creating a duplicate.

### 2.12 Reviews → modal with image attachments via a Post

The write-review surface is a modal (mirroring the existing `EditResourceReviewModal` for AI models). **The modal supports image attachments** — users reviewing a 3D model can post photos/renders of how they used it (e.g. "here's how this character looks in my game"). This is product-prioritized for Model3D where the AI-side connection is loose.

Implementation: the review modal optionally creates a `Post` (containing the attached images) and links it via `Post.model3dReviewId` (new nullable `@unique` column). The review detail surfaces those images inline.

A `Model3DReview` can have at most one associated Post (`Post.model3dReviewId @unique`). Empty-images reviews skip Post creation entirely.

### 2.13 Generation cost preview → orchestrator `whatif`

PolyGen's `whatif` query param (existing orchestrator pattern) returns the Buzz cost based on input params. The form calls `whatif` on param-change (debounced) to show estimated cost inline. No separate billing infrastructure needed — pricing lives in the orchestrator.

### 2.14 Routes

| Route                            | View                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `/3d-models`                     | Feed (Meilisearch-backed)                                                         |
| `/3d-models/[id]`                | Detail: preview, general info, files dropdown, generation details, comments, makes/uses |
| `/3d-models/[id]/reviews`        | Reviews list + write-review CTA                                                   |
| `/user/[username]/3d-models`     | Per-user profile tab                                                              |
| (generation surface)             | Existing generation panel, new "3D Model" type                                    |

---

## 3. Schema Changes

All additive. Per CLAUDE.md, we write the SQL and surface it for manual application — no `prisma migrate deploy`.

Migration file: `prisma/migrations/20260526120000_add_3d_models/migration.sql`.

### New tables

```prisma
model Model3D {
  id               Int            @id @default(autoincrement())
  name             String         @db.Citext
  description      String?
  userId           Int
  thumbnailImageId Int?           @unique  // nullable + SetNull; required-at-publish enforced in app
  licenseId        Int
  licenseDetails   String?
  workflowId       String?        @unique  // orchestrator workflow ID; UNIQUE prevents dup Post-from-Generation
  sourceImageId    Int?                    // image-to-3D source
  generationParams Json?                    // PolyGen input snapshot
  status           Model3DStatus  @default(Draft)
  nsfw             Boolean        @default(false)
  tosViolation     Boolean        @default(false)
  poi              Boolean        @default(false)
  minor            Boolean        @default(false)
  unlisted         Boolean        @default(false)
  lockedProperties String[]       @default([])
  availability     Availability   @default(Public)
  nsfwLevel        Int            @default(0)
  meta             Json           @default("{}")
  // timestamps + deletion fields. No `scannedAt` — only the thumbnail Image is scanned in v1.
}

model Model3DFile {
  id        Int      @id @default(autoincrement())
  model3dId Int
  name      String
  url       String
  sizeKB    Float    // no cap in v1
  format    String   // normalized lowercase: 'glb' | 'fbx' | 'obj' | 'usdz' | 'stl' | ...
  isPrimary Boolean  @default(false)  // at most one per Model3D
  // virusScanResult defaults to 'Success' for v1 (orchestrator-trusted); set 'Pending' when uploads land
  @@unique([model3dId, format])
}

model Model3DLicense        { /* CC-BY, Personal Use Only, etc. */ }
model Model3DReport         { /* per-entity report */ }
model Model3DReview         { /* rating 1..5 + recommended + details, unique per (model3dId, userId) */ }
model Model3DReviewReport   { /* report-on-review */ }
model TagsOnModel3D         { model3dId, tagId }
model Model3DEngagement     { /* Favorite / Hide / Notify */ }
model Model3DMetric         { /* downloadCount sourced from ClickHouse, ratingAvg, etc. */ }

enum Model3DStatus         { Draft Published Unpublished Deleted }
enum Model3DEngagementType { Favorite Hide Notify }
// No Model3DFileType enum — `format` is free-text String to match Meshy output
```

### Removed from earlier revs

- **`Model3DReaction`** — react on the thumbnail Image instead. Saves a table + service + UI plumbing.
- **`Model3DDownloadHistory`** — download events go to ClickHouse. Aggregate into `Model3DMetric.downloadCount`.
- **`Model3DFileType` enum** — `format` is String now.

### Existing-table touch list

| Surface | Change | Notes |
|---|---|---|
| `Thread` | `model3dId Int?`, `model3dReviewId Int?` | both `@unique`, `SetNull`. Reviews get comment threads too. |
| `Post` | `model3dId Int?`, `model3dReviewId Int?` | `model3dId` for community Posts + creator generation Post; `model3dReviewId @unique` for review-with-images Posts |
| `BuzzTip` schema validation | extend allow-list enum in `src/server/schema/buzz.schema.ts:136` | DB is polymorphic, schema isn't |
| `Collection.CollectionType` enum | add `Model3D` | hardcoded enum |
| `CollectionItem` | add `model3dId Int?` + extend unique constraint | four-FK pattern |
| `EntityType` enum | add `Model3D` | for `JobQueue` background pipelines |
| `CosmeticEntity` enum | add `Model3D` | optional |
| `TagTarget` enum | add `Model3D` | + `image-scan-result.ts:646` default-target list |
| `ReportEntity` enum (`src/shared/utils/report-helpers.ts`) | add `Model3D`, `Model3DReview` | hardcoded |
| `commentv2.schema.ts` | add `Model3D` + `Model3DReview` to enum lists | two locations |
| Notifications | new SQL for `new-3d-model-comment` + `new-3d-model-review` | hand-written |
| `ProfileNavigation.tsx` | add 3D Models tab | hardcoded static list |
| `SearchIndexEntityTypes` (`src/components/Search/parsers/base.ts:25-34`) | add `'Model3D'` key (PascalCase) + new parser | for new Meilisearch index |
| `GenerationForm.tsx` segmented control | add "3D Model" alongside existing Image / Video | (no Audio tab today — earlier rev had this wrong) |
| `nsfwLevels.service.ts` | add `updateModel3DNsfwLevels` batched job | propagates thumbnail Image's nsfwLevel up to Model3D |
| Metrics rollup job | new `updateModel3DMetrics` | populates Model3DMetric from comments/reviews/collections/thumbnail ImageMetric reactions |
| `Image.metadata` | (no schema change) add `kind: 'render' \| 'photo'` | UI-only |

### Indexes

- `Model3D (userId, status, publishedAt DESC)` — profile pages
- `Model3D (status, publishedAt DESC)` — feed
- `Model3D (status, nsfwLevel, publishedAt DESC)` — NSFW-aware feed
- `Model3D (workflowId hash)` — find Model3D by orchestrator workflow
- `Model3D (sourceImageId hash)` — find Model3Ds derived from an image
- `Model3DFile (model3dId hash)`, `(model3dId, format)` unique
- `Model3DReview (model3dId, userId)` unique
- All other report/engagement/metric indexes match existing patterns.

### Seed data

- `Model3DLicense` rows: CC-BY 4.0, CC-BY-NC 4.0, Personal Use Only, No Commercial Print Farm, All Rights Reserved, Custom.
- `Tag` rows with `target = Model3D`: character, creature, environment, prop, vehicle, architecture, furniture, low-poly, stylized, realistic, abstract, sci-fi, fantasy. `ON CONFLICT` handling for tags that already exist.

---

## 4. Phased Plan

### Phase 1 — Schema + generation panel + save-as-Model3D + detail page (M)

Behind feature flags `model3d-feed` + `model3d-generator` (both mod-only at launch — see §2.11).

**Backend**

- Schema migration: new tables + existing-table touch list (§3) + seed data.
- New service `src/server/services/model3d.service.ts`: `upsertModel3D`, `getModel3DById`, `getModel3DsInfinite` (mod-only), `publishModel3D`, `unpublishModel3D`, `deleteModel3D`, `getModel3DFiles` (signed download URLs).
- New router `src/server/routers/model3d.router.ts`.
- **Orchestrator integration** (unblocked — `@civitai/client@0.2.0-beta.67` ships PolyGen):
  - New `src/server/services/orchestrator/ecosystems/polyGen.handler.ts` mirroring `sora.handler.ts` shape. Builds a `PolyGenStep` for `submitWorkflow`.
  - New `src/server/orchestrator/polygen/polygen.schema.ts` — discriminated union mirroring `MeshyTextTo3dFalPolyGenInput` / `MeshyImageTo3dFalPolyGenInput` plus a `sourceImageSchema` for image-to-3D (mirroring Sora's source-image ingestion).
  - Register in `src/server/orchestrator/generation/generation.config.ts` (sibling to existing video/image configs).
  - **Workflow result handler** (server-side, runs on workflow completion): ingests `PolyGenOutput.thumbnail` as an `Image` row via the existing image-ingest pipeline (NSFW + CSAM scan); copies `model.url` and `fbxModel?.url` blobs into our S3 (`3d/` prefix); normalizes `Model3dBlob.format` (lowercase, strip leading dot); creates the `Model3D` row in `Draft` with `workflowId` set; creates `Model3DFile` rows (one per format).
  - Idempotence: `Model3D.workflowId` is UNIQUE; re-running the handler on the same workflow returns the existing draft.
- `commentsv2.service.ts` + `commentv2.schema.ts` enum edits.
- `BuzzTip` schema validation edit.
- `ReportEntity` enum edit (`src/shared/utils/report-helpers.ts`).
- New `Model3DReport` + `Model3DReviewReport` tables + report router edits.
- Mod-queue UI edit: `/moderator/reports` accepts the new report tables.
- New comment notifications: `new-3d-model-comment`, `new-3d-model-comment-response`, `new-3d-model-comment-nested`.
- `EntityType` + `TagTarget` enum additions; `image-scan-result.ts:646` edit.
- **New batch jobs**:
  - `updateModel3DNsfwLevels` in `src/server/services/nsfwLevels.service.ts` — propagates `Image.nsfwLevel` (thumbnail) to `Model3D.nsfwLevel`. Without this, the column stays at 0 forever.
  - `updateModel3DMetrics` — populates `Model3DMetric` from `CommentV2`, `Model3DReview`, `CollectionItem`, `BuzzTip`, and the thumbnail Image's `ImageMetric` (for `reactionCount`).

**Frontend**

- **Generation form**: new "3D Model" segmented-control option in `GenerationForm.tsx` (alongside existing Image and Video — there is no Audio today). Two sub-tabs: text-to-3D, image-to-3D. Form fields mirror PolyGen schema (all of `MeshyFalPolyGenInput` + the operation-specific fields).
- **Generation queue card**: new 3D-model card showing the thumbnail Image (NOT an inline WebGL viewer — multiple cards on the page would create N WebGL contexts). "Post from Generation" CTA mirrors the existing image/video flow: creates empty Post → redirects to `/posts/[id]/edit`. The Model3D draft was already created by the workflow result handler; the edit page binds them together via `Post.model3dId`.
- **Detail page** `/3d-models/[id]/[[...slug]].tsx`:
  - 3D viewer (`<STLViewer />` rebranded `<Model3DViewer />`, GLB-first via three.js + GLTFLoader)
  - General info (name, description, creator, license)
  - Files dropdown (select format → download)
  - Generation Details section (prompt, topology, polycount, seed, source image if image-to-3D)
  - Comments section (existing Thread/CommentV2)
  - "Makes & Uses" rail (community Posts where `Post.model3dId = id`)
- **Reviews page** `/3d-models/[id]/reviews.tsx` — list + write-review CTA. Star rating, recommend checkbox, free-text details.

**Critical files**

- `prisma/schema.prisma` + migration
- `src/server/services/model3d.service.ts` + `model3d-review.service.ts` + `model3d-report.service.ts`
- `src/server/routers/model3d.router.ts`
- `src/server/orchestrator/polygen/polygen.schema.ts` + workflow handler
- `src/server/notifications/comment.notifications.ts` (large edit)
- `src/components/Model3D/Viewer/Model3DViewer.tsx` (three.js + GLTFLoader, dynamic-imported)
- `src/components/Generation/Model3D/Model3DGenerationForm.tsx`
- `src/pages/3d-models/[id]/[[...slug]].tsx`, `[id]/reviews.tsx`
- Generation panel content-type selector
- `src/server/services/feature-flags.service.ts`

### Phase 2 — Discovery (feed + profile tab + search bar entry) + community Posts (S–M)

Broadens the audience of `model3d-feed` / `model3d-generator` from `mod` to wider groups via Flipt (no code change).

- New `src/server/search-index/model3d.search-index.ts` — dedicated Meilisearch index.
- `SearchIndexEntityTypes` in `src/components/Search/parsers/base.ts:25-34` — add `model3d` + new parser + new instantsearch tab.
- New `src/pages/3d-models/index.tsx` — feed grid.
- New `src/components/Cards/Model3DCard.tsx`.
- New `src/pages/user/[username]/3d-models.tsx` — profile tab.
- `ProfileNavigation.tsx` static-list edit + `userProfile.overview` count.
- `PostUpsertForm2` — allow linking a Post to a `Model3D` via `model3dId`. Add `Image.metadata.kind = 'photo'` selector for "Makes/Uses" posts.

### Phase 3 — User uploads (deferred)

- New upload flow analogous to existing model uploads, but with content moderation gating.
- Writes rows with `workflowId = NULL` (schema already supports this).
- Requires: 3D content moderation strategy, virus/integrity scanning beyond pass-through, mod tooling for 3D files.

---

## 5. Content Policy

Same as rev 4 — generated content is gated by the orchestrator's existing user-tier policies (`allowMatureContent` query param). Mod queue applies to user-uploaded content via `Model3DReport`.

- **NSFW / printed photos** in "Makes/Uses" Posts: standard `Image` moderation pipeline.
- **Weapons / firearms**: total ban; orchestrator-side prompt filtering + mod review.
- **POI / real-person likenesses**: standard Civitai POI rules apply to the thumbnail Image and the prompt.
- **Copyrighted IP**: report-driven via `Model3DReport`. New "Copyrighted IP" report reason.

The orchestrator-side `allowMatureContent` toggle is the primary lever for v1 — users who can't see mature content can't generate it.

---

## 6. Risks

1. **Viewer perf on FBX-with-rigging** — `enableRigging` + `enableAnimation` Meshy outputs may exercise three.js paths we haven't tested. Soft warning above some triangle count threshold.
2. **NSFW moderation surface** — only the thumbnail Image gets scanned. Prompts that produce questionable 3D content but innocuous thumbnails slip through. Mitigation: `allowMatureContent` gating + report queue.
3. **Reaction-on-thumbnail UX leak** — accepted trade-off, but with side effects to call out: (a) user's profile "liked content" surfaces liked thumbnail Images, not Model3Ds — needs a query shaper to lift these into "liked 3D models" or remain as Images; (b) replacing a thumbnail (changing `Model3D.thumbnailImageId`) drops the reaction count visible on the card unless the old `Image` row is preserved; (c) feed sort-by-popular reads `Model3DMetric.reactionCount` (denormalized rollup from the thumbnail's `ImageMetric`) — needs the rollup job to run. Mitigations are real but each costs work.
4. **PolyGen cost** — Meshy charges per generation; need a Buzz pricing model. Use PolyGen's `whatif` query param to preview cost at form-load. Coordinate with billing.
5. **Generation reliability** — Meshy generation can fail or time out. Standard orchestrator failure handling applies, but the UX needs a clear "Generation failed, try again" path.
6. **`Model3dBlob.url` is nullable / may expire** — workflow result handler must handle the "blob not yet available" and "URL expired" cases. Standard re-presign retry pattern.
7. **ClickHouse downloads are lossy** — fire-and-forget on download click; if ClickHouse is unavailable we lose the event. Acceptable for counts; flagged for visibility.
8. **Notifications copy-paste burden** — new notification types per `comment.notifications.ts` pattern. Budget 4–6.
9. **Schema enumeration sites** — 15+ surfaces touched (see §3 touch list, now including `ReportEntity`, `SearchIndexEntityTypes`, NSFW + metric rollup jobs). Easy to miss; grep audit before merge.

---

## 7. Out of Scope (v1)

- **User uploads** — Phase 3. Schema is upload-ready (nullable `workflowId`), code path is not.
- **GLB derivation from STL** — irrelevant; we receive GLB directly from Meshy.
- **OBJ / GLTF / 3MF / STEP upload paths** — Phase 3.
- **Slicer integration / G-code / print-time estimates**.
- **Marketplace / paid downloads**.
- **Print-farm verification / "verified printer" badges**.
- **Multi-part assembly UI**.
- **Vault eligibility for 3D files**.
- **Bulk-import from Printables / Thingiverse / MakerWorld**.
- **Versioning** — `Model3D` is atomic; iteration = new Model3D.

---

## 8. Decision Log

| # | Question | Decision | Notes |
|---|---|---|---|
| 6.1 | Post → Model3D linkage | Nullable `model3dId` column on `Post` | Mirrors `modelVersionId` |
| 6.2 | License model | New `Model3DLicense` table | 3D-asset-specific dimensions |
| 6.3 | File size cap | **No cap in v1** | Storage not a constraint per product direction; revisit if egress spikes |
| 6.4 | Viewer cap for huge files | Soft warning above threshold | Still render |
| 6.5 | Tag taxonomy | Generic 3D-asset tags (subject + style) | Dropped print-specific (FDM, Resin, etc.) |
| 6.6 | "Create" entry point | Top-nav Generate menu, new "3D Model" type | Replaces upload-wizard idea |
| 6.7 | Reviews | **IN scope (v1)** | `/3d-models/[id]/reviews`, parallel to ResourceReview |
| 6.8 | Weapons / firearms policy | Total ban | Orchestrator prompt filter + mod review |
| 6.9 | POI policy | Standard Civitai POI rules apply to thumbnail + prompt | |
| 6.10 | Meilisearch | Dedicated `model3d` index | New entity ⇒ new index |
| 6.11 | GLB derivation | N/A — receive GLB directly from Meshy | |
| 6.12 | New entity vs. extend `Model` | New entity (locked) | "Model" in Civitai means AI generation resource |
| 6.13 | Asset access policy | Public alongside thumbnail | Standard signed-URL pattern |
| 6.14 | Source of v1 models | **Generation only (PolyGen / Meshy)** | Uploads deferred to Phase 3 |
| 6.15 | Reactions on Model3D | Skip; users react to thumbnail Image | Saves a table + plumbing |
| 6.16 | Download tracking | ClickHouse events, no Postgres table | Denormalized into `Model3DMetric.downloadCount` |
| 6.17 | Versioning | None in v1 | Future: add `Model3DVersion` if demand emerges |
| 6.18 | File format storage | One `Model3DFile` per format, `isPrimary` for default | Unique on `(model3dId, format)` |
| 6.19 | Thumbnail source | PolyGenOutput.thumbnail, fallback to sourceImage, fallback to placeholder | Scanned through standard Image pipeline |
| 6.20 | Phase 1 effort | **L** (honest) | three.js install + viewer + handler + form + result handler + detail page + reviews UI + jobs + 15+ enum sites |
| 6.21 | Reaction-on-thumbnail UX leaks | **Accepted for pilot** | Mitigations cost ~1 week; revisit post-pilot if usage shows it matters |
| 6.22 | Review-with-images linkage | New `Post.model3dReviewId Int? @unique` | Modal optionally creates a Post for image attachments |
| 6.23 | Mod tooling for 3D | **Thumbnail-driven** | Image mod action affords "also unpublish parent Model3D"; no 3D-specific queue in v1 |
| 6.24 | Feature flag split | `model3d-feed` + `model3d-generator` (both mod-only) | Feed access ≠ generation access |
| 6.25 | Buzz pricing for PolyGen | Orchestrator `whatif` query param | Debounced call on form change; no billing infra |
| 6.26 | Generation Details params | Show params likely common across 3D gen providers | prompt, topology, polycount, symmetry, PBR, mode, seed, rigging, animation, texture prompt, source image. Hide provider-specific (e.g. `enablePromptExpansion`). |

---

## 9. Revision History

- **Rev 1** (2026-05-26): initial draft. New-entity, STL+auto-GLB, user-thumbnail, Meshy deferred. Estimated Phase 1 M–L.
- **Rev 2** (2026-05-26): critical review surfaced (a) schema is entity-enumerated not polymorphic; (b) no proven Node STL→GLB library; (c) auto-Post pattern was invented, not mirrored; (d) Phase 1 was actually L–XL. Split Phase 1 into 1a/1b/1c. Added §6.7–6.13.
- **Rev 3** (2026-05-26): decisions locked. GLB derivation dropped. ResourceReview skipped (then). Policies added as §5.
- **Rev 4** (2026-05-26): versioning removed. `Model3DVersion` and friends deleted; thumbnail/license/files moved to `Model3D`. `Post.model3dVersionId` → `Post.model3dId`.
- **Rev 5** (2026-05-27): pivoted to **generation-only**. User uploads deferred to Phase 3 (schema is upload-ready). Dropped `Model3DReaction` (users react to thumbnail Image) and `Model3DDownloadHistory` (ClickHouse handles download events). **Reviews back in scope** with `Model3DReview` + `/3d-models/[id]/reviews` route. `Model3DFile.type` enum → `format` String to accept any Meshy output format. Added `Model3D.workflowId`, `sourceImageId`, `generationParams`. New routes: `/3d-models`, `/3d-models/[id]`, `/3d-models/[id]/reviews`. Tag taxonomy genericized (no print-specific tags). PolyGen integration documented (text-to-3D + image-to-3D via Meshy/Fal).
- **Rev 6** (2026-05-27): `@civitai/client@0.2.0-beta.67` installed — exports `invokePolyGenStepTemplate`, `Meshy*PolyGenInput` variants, `Model3dBlob`. Orchestrator client dependency cleared; Phase 1's generation form is no longer blocked. Removed "Orchestrator PolyGen rollout" from the risk register.
- **Rev 7** (2026-05-27): storage no longer a constraint per product direction. Dropped 500 MB per-file CHECK from migration and app-layer enforcement plan. Removed "Storage / egress" from the risk register. File size cap decision log entry (6.3) updated to "no cap in v1".
- **Rev 8** (2026-05-27): third-review tightening pass. **Schema**: `Model3D.workflowId` → UNIQUE (prevents dup Post-from-Generation), `Model3D.scannedAt` dropped (no defined writer; only thumbnail is scanned), `Model3DFile.virusScanResult` default → `'Success'` (orchestrator-trusted in v1), added `Model3DMetric.reactionCount` denormalized from the thumbnail's `ImageMetric`. **Plan**: §2.2 corrected to use `submitWorkflow` + `PolyGenStep` (async workflow) instead of `invokePolyGenStepTemplate` (sync); §2.4 acknowledges three.js viewer is from-scratch + requires install; §2.11 spells out the "Post from Generation" flow matching `GeneratedImageActions.tsx` pattern; queue cards show thumbnails (no inline WebGL); §3 touch list adds `ReportEntity` enum, `SearchIndexEntityTypes` (PascalCase), NSFW propagation job, metrics rollup job; §6 acknowledges reaction-on-thumbnail UX leak as accepted trade-off with mitigation costs. Diagram and summary aligned.
- **Rev 9** (2026-05-27): open questions resolved with product. Phase 1 acknowledged as **L** (not M). Reaction-on-thumbnail leaks accepted for pilot. **Reviews are a modal with image attachments**: new `Post.model3dReviewId Int? @unique` lets a review own a Post that carries its attached images; this formalizes the AI-side "loose Post↔Review connection" as a stronger link for 3D. **Mod tooling**: thumbnail-driven — image-mod page gains "also action parent Model3D" affordance, no 3D-specific queue in v1. **Two Flipt flags**: `model3d-feed` (view/comment/review) + `model3d-generator` (create). **Buzz pricing**: orchestrator's `whatif` query param, no separate billing infra. **Generation Details**: surface provider-agnostic 3D-gen params (prompt, topology, polycount, symmetry, PBR, mode, seed, rigging, animation, texture prompt, source image). Schema.prisma is **source of truth** — migrations are generated from it, not the other way around; re-applying all Model3D additions to the schema now.
