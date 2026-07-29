# Plan: Safetensors File Rename Before Publishing

## Context

When users train models on Civitai and publish them, the safetensors filename is auto-derived from the orchestrator's asset path (e.g., `abc123_0000010.safetensors`). These names are opaque and unhelpful to end users downloading the model. This feature lets users specify a meaningful display/download name (and optional version string) before or after publishing.

## Approach: `overrideName` (display name only — recommended)

**Recommended approach** is to use the existing `overrideName` field on `ModelFile` (already in Prisma schema at `prisma/schema.prisma:1117`). The S3 path and `name` field stay unchanged; `overrideName` overrides what users see and what browsers name the downloaded file. The `getDownloadFilename()` function at `src/server/services/file.service.ts:389` already checks `overrideName` first — no new logic needed there.

**Why not rename the S3 file itself?** No collision risk (S3 keys are scoped to `modelVersion/{modelVersionId}/`) — but it adds a copy+delete operation during the already-slow publish flow, requires modifying `moveAsset`, and makes the change hard to undo. The `overrideName` approach gives the same user-visible result with no storage-layer changes and is fully reversible.

**Complexity vs. option 2 (post-publish only):** Adding a rename input pre-publish in `TrainingSelectFile` is modest extra work — one text input and a small schema change. Starting with pre-publish only (option 2) would mean users see the garbled name first and have to hunt for an edit UI. Option 3 (both) is the right UX; the extra effort is minimal since the Zod schema change covers both anyway.

## Default value

Pre-fill from `modelVersion.name` (available in `TrainingSelectFile` props), with the `.safetensors` extension appended if not present. This is already a user-defined value from the training form. Fall back to the auto-derived filename if `modelVersion.name` is empty.

---

## Implementation Steps

### 1. Zod schema — expose `overrideName`
**File:** `src/server/schema/model-file.schema.ts`

Add `overrideName: z.string().optional()` to:
- `modelFileCreateSchema`
- `modelFileUpdateSchema`

(The union `modelFileUpsertSchema` derives from these automatically.)

### 2. Service layer — persist `overrideName`
**File:** `src/server/services/model-file.service.ts`

In `createFile` and `updateFile` (and `upsertFile` if it exists), pass `overrideName` through to the Prisma call. The field is already on the `ModelFile` model so no migration is needed.

Check `src/server/controllers/model-file.controller.ts` — if the controller maps input to service params manually, add `overrideName` there too.

### 3. Pre-publish UI — rename input in TrainingSelectFile
**File:** `src/components/Resource/Forms/TrainingSelectFile.tsx`

In the epoch selection/publish dialog (near the existing publish button, around line 600–632):
- Add a controlled `TextInput` labeled "File name" (or "Custom filename")
- Default value: `modelVersion.name` (from props) + `.safetensors`, falling back to the auto-derived name from the epoch URL
- Include a short helper text: "This name will be shown to users downloading the file"
- When `upsertFileMutation.mutate(...)` is called (line 621), include `overrideName: customName || undefined`

The input should only show when the user is about to publish (not on initial epoch list view). Look for the existing publish confirmation flow/modal in the component and insert it there.

### 4. Post-publish UI — rename in model version edit form
**Files to identify:** wherever model files are listed for editing on the model version edit page (likely `src/components/Model/ModelVersions/` or `src/pages/models/[id]/edit.tsx`)

Find where `ModelFile` records are displayed in edit mode. Add an editable `TextInput` for `overrideName` alongside the existing file row, wired to the `modelFile.update` tRPC mutation.

Use the Explore agent at implementation time to locate the exact edit-form file if not immediately obvious.

### 5. Selector — add `overrideName` to `modelFileSelect`
**File:** `src/server/selectors/modelFile.selector.ts`

The shared `modelFileSelect` (lines 3–27) does not include `overrideName`. Add `overrideName: true` so all consumers (tRPC `modelFile.getByVersionId`, model-version caches, etc.) receive the field and can display or edit it on the client.

### 6. SQL query in `/api/v1/model-versions/[id]` — already handled
The raw SQL at `src/pages/api/v1/model-versions/[id].ts` doesn't select `overrideName`, but results go through `prepareModelVersionResponse()` which calls `getDownloadFilename()` — so the public API filename is already correct once `overrideName` is set. No change needed here.

### 7. Download handler — already handled
`src/pages/api/download/models/[modelVersionId].ts` calls `getFileForModelVersion()` in `file.service.ts`, which already selects `overrideName` (line 282) and passes it to `getDownloadFilename()`. Downloads will automatically use the custom name with no changes needed.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/server/schema/model-file.schema.ts` | Add `overrideName` to create + update schemas |
| `src/server/services/model-file.service.ts` | Pass `overrideName` to Prisma in create/update |
| `src/server/controllers/model-file.controller.ts` | Forward `overrideName` from input to service (if mapped manually) |
| `src/server/selectors/modelFile.selector.ts` | Add `overrideName: true` to `modelFileSelect` |
| `src/components/Resource/Forms/TrainingSelectFile.tsx` | Add rename `TextInput` before publish, include in upsert call |
| Model version edit form (locate at impl time) | Add `overrideName` `TextInput` to file edit row |

## No migration needed

`overrideName String?` already exists on the `ModelFile` Prisma model. No SQL changes required.

## Verification

1. Start dev server (`/dev-server`)
2. Navigate to a trained model in the Training section
3. Select an epoch to publish — verify the custom filename input appears, pre-filled with the version name
4. Change the name, publish — verify the DB record has `overrideName` set (check via `/postgres-query`)
5. Download the model file — verify the browser saves it with the custom name
6. Go to model version edit page — verify the `overrideName` field is editable there too
7. Run `pnpm run typecheck` to confirm no type errors
