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

---

## Open Bugs

### Reference image upload stuck at 75%
Often gets stuck during upload. Needs investigation into the CF upload flow and progress tracking.

### Can't drag from Generator into References
Drag-and-drop from the generator into references doesn't work. The "Pick from Generator" button works as a workaround.

### Need to refresh page after every action
Missing optimistic updates across multiple flows: import panels, upload images, etc. The polling fix addresses generation completion, but other actions may still need attention.

### Sketch edit various issues
- Sketch edit then Regenerate gives an entirely new image (expected: should apply sketch changes)
- Sketch edit pulls in files from previous generations / unrelated references
- Confusion between standalone Sketch Edit and the Enhance > Annotate flow
- **Suggestion from testers:** Rename "Enhance" to "Edit/Enhance Panel" and remove standalone Sketch Edit to reduce confusion

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
