# Comics Feature - Bug & Feedback Tracker

## Fixed

### Panel generation not updating until page refresh
Images appear in the generator but don't pull into the panel until refresh or clicking into the panel.
**Root cause:** Polling used `refetch()` which could return stale React Query cache data. The polling also stopped before the refetch completed.
**Fix:** Optimistically update panel data from poll results immediately, then use `invalidate()` instead of `refetch()` to bust the cache and get full fresh data.

### Sketch edit turning 4:3 images into 1:1
Going to "Enhance Panel" then "Annotate Image" would produce a square canvas regardless of original aspect ratio.
**Root cause:** `handleEnhanceExisting` used `panel.image?.width ?? 1024` / `panel.image?.height ?? 1024`. When `panel.image` was null (relation not populated), it defaulted to 1024x1024.
**Fix:** Both `handleEnhanceExisting` and `handleSketchEdit` now pre-load the actual image via `Image()` to get `naturalWidth`/`naturalHeight` as the primary dimension source.

### Imported images showing incorrect settings
Imported panels displayed "Prompt enhanced", "Previous context used", etc. in the detail drawer.
**Root cause:** Settings section checked `meta.enhanceEnabled !== false`, which is `true` when `enhanceEnabled` is `undefined` (as it is for imported panels).
**Fix:** Detect imported panels (`!prompt && sourceImageUrl && enhanceEnabled === undefined`) and show a single "Imported image" pill instead. Hide empty prompt box and redundant source image section.

### Grok Image generation error
Throws: "Missing 'ImageGen' config for engine 'Grok'".
**Root cause:** The Grok ecosystem handler existed but no corresponding `ImageGenConfig` was created for the comics generation path.
**Fix:** Created `grok.config.ts` with proper `metadataFn`/`inputFn` mapping to `GrokCreateImageGenInput`/`GrokEditImageGenInput`, and registered it in `imageGen.config.ts`.

### Buzz price mismatch (160 quoted vs 180 charged)
The cost estimate showed 160 Buzz for NanoBanana but actual generation charged 180.
**Root cause:** Cost estimate passed `images: null` (txt2img pricing), but actual generation passes reference images (img2img pricing, which costs 20 Buzz more on NanoBanana).
**Fix:** Cost estimate now passes a dummy reference image so the whatIf query returns the img2img price.

### Early access paywall has no limits
Users could set early access for a year and charge unlimited Buzz.
**Fix:** Capped buzz price at 10,000 and timeframe at 30 days in the server schema (`chapterEarlyAccessConfigSchema`) and both UI forms (`PublishModal`, `ChapterSettingsModal`).

### Deleted XXX panel but project NSFW stays XXX
Deleting a panel updated the chapter NSFW level but not the project level.
**Root cause:** `updateComicChapterNsfwLevels` and `updateComicProjectNsfwLevels` fired concurrently. Since project NSFW is derived from chapter NSFW (`bit_or`), the project update read stale chapter data.
**Fix:** Chained the calls so project NSFW recalculation runs after chapter NSFW completes.

### Failed panels have no delete option
Failed panels (no image) had no context menu - users had to click into the detail drawer to delete.
**Fix:** Added a three-dot context menu to the failed panel state with Regenerate, Insert after, and Delete actions.

### Enhance prompt pulls in unrelated references
The prompt enhancer injected characters that weren't @mentioned in the original prompt.
**Root cause:** `enhanceComicPrompt()` received `allReferenceNames` (every reference the user has) instead of only the @mentioned ones. The LLM interpreted the full character list as context to incorporate.
**Fix:** Now passes only the names of @mentioned references to the enhancer. Falls back to all names only when no references are mentioned at all.

### Preview button doesn't show panels
The Preview button opens a new tab but panels don't appear.
**Root cause:** Same as the polling/cache issue above. The reader endpoint correctly fetches Ready panels, but the data was stale in the query cache. The `invalidate()` fix resolves this.

### Reference image upload stuck at 75%
Upload progress bar would get stuck and `isUploading` never reset.
**Root cause:** `handleSubmit` called `addImagesMutation.mutate()` (fire-and-forget) instead of `mutateAsync()`. Progress reached 90% but never 100%, and state was only cleaned up in the `catch` block. Additionally, the "add more images" progress bar was hardcoded to 65%.
**Fix:** Changed to `await addImagesMutation.mutateAsync()` with proper progress (100%) and state (`isUploading = false`) cleanup on success. Replaced hardcoded 65% progress with real per-file upload progress average.

### Can't drag from Generator into References
Drag-and-drop from the generator into references didn't work. Only the "Pick from Generator" button worked.
**Root cause:** Dropzones in `character.tsx` only handled `onDrop` (file drops). Generator images set `text/uri-list` on drag, but no `onDropCapture` handler existed to intercept URL drops.
**Fix:** Added `onDropCapture` handlers to both reference Dropzones (new reference creation + existing reference upload). They extract the URL from `text/uri-list`, fetch the blob, wrap it in a `File`, and pass it to the existing upload handler.

### Need to refresh page after every action
UI felt sluggish because mutations only updated after server round-trip.
**Root cause:** Out of 20+ mutations, only panel/chapter/ref-image reordering had optimistic updates. Everything else called `refetch()` causing perceived lag.
**Fix:** Added optimistic `setData` updates to 6 key mutations: `deletePanelMutation` (removes panel from cache), `deleteChapterMutation` (removes chapter), `createChapterMutation` (adds placeholder), `planPanelsMutation` (added missing `onSuccess`), `deleteRefImageMutation` (removes image), `addMoreImagesMutation` (adds placeholder images). All include `onError` rollback via `refetch()`.

### Sketch edit flow rewrite
Sketch Edit saved directly to the panel image, so "Regenerate" afterward ignored the sketch entirely and generated from the original prompt.
**Root cause:** `handleSketchEdit` called `replacePanelImageMutation` which only updated `imageUrl`/`imageId` — no generation metadata. Regenerate then used the original prompt via `createPanel` (txt2img), completely discarding the annotation.
**Fix:** Rewrote Sketch Edit to feed into the Enhance pipeline: annotate → "Continue to Enhance" → upload blob to CF → PanelModal opens in Enhance tab with annotated image as source → user adjusts prompt/model → `enhancePanelMutation` generates with the annotation as img2img reference. Removed the standalone direct-replacement flow.

---

## Open Bugs / Needs Investigation

### Enhance prompt ignores user intent
Per user: "it doesn't seem to listen to me at all". Even with the reference leak fixed, the prompt enhancer may still deviate significantly from user intent. May need system prompt tuning.

---

## Improvements (Pending)

### References are global, not per-project
References span all projects. A reference created in one project can be called from another. Should be per-project, or allow importing references between projects.

### Font size inconsistencies
Minor design issue with inconsistent font sizes across the UI.

### UI issue with many references
When many references are added, the tag area grows and panels can't be seen.

### Comments look funky + no mod tools
Comments have visual issues and moderators can't delete/ToS comments.

### Tips not associated with Comics
Buzz tips on comics appear as direct tips rather than being linked to the comic.

### No way to change panel age ratings
Panels have NSFW ratings but no mechanism for users to request changes or mods to override.

### Reference image selection resets on prompt edit
If you mess up @mentions or add a new reference, all previously selected reference images are lost and need re-selection.

### Sketch edit model warning
Need to add a warning that sketch edit results vary by model (works well with Nano Banana, less predictable with others).

### No panel version history / undo
If regenerate or sketch edit produces a worse result, there's no way to revert. Would need panel versioning or a history of previous images.

---

## Feature Requests (Pending)

### Seedream 5 Lite as generation option
Fast and cheap model. May not be as flexible as 4.5.

### Generate character reference sheets in-app
Currently requires uploading from off-site. Would be useful to generate reference sheets directly inside "Create References".

### Animate panels
Options: Grok (expensive), LTX2.3 (cheap), Kling, Veo 3.1.

### Export to PDF/CBR
Allow exporting finished comics. Should be optional per creator (may not want to allow downloads).

### Generate multiple images per panel
"Dice-rolling" regeneration is slow. Allow generating multiple candidates and picking the best.

### Reference "about" text
Allow passing a ~100 character description with reference images for better character/location/item prompting.

### Duplicate panel / duplicate chapter
Allows refining results without risking existing work.
