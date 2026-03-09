# Comic Tester Feedback — Implementation Status

ClickUp task: https://app.clickup.com/t/868hmbhq8
Branch: `fix/comic-tester-feedback`

## Implemented

1. **Chapter renumbering on delete** — When a chapter is deleted, remaining chapters are re-compacted to sequential positions (0, 1, 2...) using a temp-offset technique to avoid primary key conflicts.

2. **Page count per chapter in overview** — The chapter list now shows "X pages" next to each chapter name.

3. **Edit button on public comic page** — Owners see an Edit button that links to `/comics/project/[id]`.

4. **Delete button on public comic page** — Owners can delete the entire comic project with a confirmation modal.

5. **Tooltip on follow bell icon** — The bell icon now has a tooltip explaining "Follow for new chapter notifications".

6. **Bifold (side-by-side) reading mode** — A toggle between scroll and pages mode. Pages mode shows 2 panels per spread with prev/next navigation, keyboard arrow support, and auto-advance between chapters. Fixed height with black/white background. Previous chapter lands on last page.

7. **Comment count fix** — Uses actual `thread.comments.length` instead of the unreliable `commentCount` field. Also checks `thread.locked` to hide the comment input when locked.

8. **Comment notifications** — Notifies comic owners when someone comments on their chapter, using the existing notification system (`new-comic-comment` type).

9. **Cover image cropping** — Cover uploads in both `create.tsx` and `project/[id]/index.tsx` now open `ImageCropModal` with 3:4 aspect ratio before uploading.

10. **Comment reactions** — `getChapterThread` query now includes `reactions` in comment select, and `<CommentReactions>` component is rendered below each comment in `ChapterComments.tsx`.

11. **Comic age rating badge** — Public comic page shows a content rating badge (e.g. "PG-13", "R") next to the title when `nsfwLevel > 0`, using `getBrowsingLevelLabel()`.

12. **Faster generated images polling** — Reduced polling interval from 3000ms to 1500ms in the editor workspace.

13. **Image import picker** — New "Import" tab in the panel creation modal allows selecting images from generator history, uploading them to CF, and creating panels via bulk create.

14. **Tip total display** — Replaced `TipBuzzButton` with `InteractiveTipBuzzButton` showing accumulated tip total (queried from `BuzzTip` table) with optimistic session-local updates via `useBuzzTippingStore`.

15. **Chapter early access / paywall** — Creators can set a Buzz price and timeframe when publishing a chapter. During early access, readers must pay to unlock. After the timeframe, the chapter becomes free. Uses `EntityAccess` table + DB trigger mirroring ModelVersion pattern. Panels are stripped server-side for locked chapters. Added `id` (autoincrement unique), `availability`, `earlyAccessConfig`, `earlyAccessEndsAt` to ComicChapter schema. New mutations: `purchaseChapterAccess`, `updateChapterEarlyAccess`. Migration: `20260304123827_comic_chapter_early_access`.

16. **Publish modal with paywall config** — Publishing a chapter now opens a modal with an optional "Enable Early Access Paywall" toggle, Buzz price input, and timeframe (days) input. A separate "Paywall" button next to "Publish" opens the same modal with EA pre-enabled.

17. **Paywall indicators in editor** — Paywalled chapters show a yellow lock icon and yellow status dot in the sidebar, with a "Paywalled · X Buzz" tooltip. The chapter header shows a yellow badge with the price.

18. **Chapter settings modal** — Replaced inline chapter name editing with a settings modal (gear icon). Contains: name input, EA config (for published chapters, can only reduce price/timeframe), and delete button with loading states.

19. **Loading states for chapter operations** — Add chapter button shows a spinner while creating. Delete shows a spinner on the sidebar item and modal button. Update shows a spinner on the sidebar item while saving.

20. **Bulk upload image fix in reader** — Panel images uploaded via bulk import were only showing as raw CF UUIDs in the reader. Fixed by wrapping all panel image URLs in `getEdgeUrl()` in the reader's `renderPanel` function.

21. **Moderation tools** — `tosViolation` field on ComicProject. Moderator procedures: `setTosViolation` (toggles flag, notifies creator, hides from listings/search) and `moderatorUnpublishChapter` (reverts to draft, notifies creator). TOS-violated projects are hidden from `getPublicProjects` and blocked in `getPublicProjectForReader` for non-owner/non-mod. Frontend: red TOS violation banner on overview, moderator dropdown menus on both overview (flag/unflag) and chapter reader (unpublish). Report button added to chapter reader header (reports at project level).

22. **Unpublish protection** — Published chapters that have been purchased by someone via early access cannot be unpublished by the creator.

23. **Multi-model support** — Project-level model selection. Creators can choose between NanoBanana (default), Seedream v4.5, OpenAI GPT-Image, or Qwen in Project Settings. Each model has its own aspect ratio options. The config map (`COMIC_MODEL_CONFIG`) stores engine, baseModel, versionId, and available sizes per model. Qwen uses a separate `img2imgVersionId` for image-to-image generation. Flux2 was evaluated but excluded (only supports 4 images per request).

24. **Persistent panel images (CF upload)** — Generated panel images are now uploaded to Cloudflare Images before creating the Image record. Previously, panels stored raw orchestrator URLs which expire within 30 days. Now uses `uploadViaUrl()` to persist to CF, storing the CF image ID. Applies to all generation paths (create, enhance, bulk, smart create) via the single polling endpoint.

25. **NSFW level indicators** — Panel cards show a colored NSFW badge (PG/PG-13/R/X/XXX) based on the image's `nsfwLevel` from content moderation. Badges also appear on the chapter sidebar (next to page count) and project header (next to stat pills). Uses bitwise flag detection to find the highest set level.

26. **Circular dependency fix (media-schemas)** — Fixed `ReferenceError: Cannot access 'imageValueSchema' before initialization` caused by circular imports in the data-graph generation system. Extracted Zod schemas (`imageValueSchema`, `videoMetadataSchema`, `videoValueSchema`) into a leaf module `media-schemas.ts` that has no circular dependencies, while keeping version IDs in their respective graph files.

27. **Pick from generator for cover/hero images** — Both the create page and project settings modal now have a "Pick from generator" button below the cover and hero dropzones. Opens `ImageSelectModal` with generator history, fetches the selected image, uploads to CF, and sets it as the cover or hero. Uses the same pattern as the panel import picker.

## Not Implemented — Feasibility Analysis

### Requires significant new work (medium-high effort)

| Feedback | Effort | Details |
|----------|--------|---------|
| **Dedicated moderator comics queue** | Medium | Report system works (`ComicProjectReport` exists, reports show in `/moderator/reports`). Core moderation tools (TOS flag, mod unpublish) are implemented. Missing: dedicated `/moderator/comics.tsx` page, text moderation (Clavata) integration, and report-action workflow linking. |
| **Per-chapter reporting** | Low-Medium | Currently reports are at the project level. Adding `ReportEntity.ComicChapter` requires DB model, report schema, and moderator queue integration. |
| **Setting/art style reference** | Unknown | AI generation feature — needs orchestration/model changes and UX for style reference input. |
| **Feed panels from previous chapters** | Unknown | AI generation feature — needs orchestration changes to accept reference panels as context. |
| **Reference image tagging** (e.g. "@character with item") | Unknown | AI generation feature — needs UX + prompt engineering for tagged references. |
| **Comic images in user's posts/images** | TBD | Architecture decision on how comic panels relate to user gallery. Panels already have `imageId` FK to `Image` table, so the data relationship exists. |
| **PDF export** | Medium | Needs PDF generation service + creator permission controls + optional Buzz-gated download. |
| ~~**More model options / price range**~~ | ~~Product decision~~ | ~~Implemented as item #23 — multi-model support with 4 engines.~~ |
| **Reactions on image panels** | Intentionally skipped | Testers specifically warned against this: "johnny civ is 100% going to fill someone's Romance Tragedy last panel with laughing face reacts" |
