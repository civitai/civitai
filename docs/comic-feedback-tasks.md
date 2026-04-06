# Comic Feedback Tasks

Breakdown of [Comic Feedback (868j280v0)](https://app.clickup.com/t/868j280v0).

---

## 1. Apostrophes break character mention detection

**Files:** `src/server/services/comics/mention-resolver.ts`, `src/server/services/comics/prompt-enhance.ts`

The mention regex in `mention-resolver.ts:22` uses apostrophe `'` as a boundary character in its lookahead, so `@O'Brien` only matches `@O`. Similarly, `prompt-enhance.ts:126` uses `/@([\w\p{L}]+)/gu` which doesn't include apostrophes in its character class.

**Fix:** Update both regexes to treat apostrophes as part of the name, not as a boundary.

---

## 2. AI enhance prompt drops @ from tagged characters

**Files:** `src/server/services/comics/prompt-enhance.ts`

Related to #1. The LLM output goes through a cleanup step that strips unrecognized @-mentions. If apostrophe-containing names fail to match (see #1), they get stripped. Additionally, the regex at line 126 may partially match names, leaving fragments behind.

**Fix:** After fixing #1, verify the full enhance pipeline preserves @-mentions for all valid reference names. Add test cases for names with apostrophes, hyphens, and unicode characters.

---

## 3. References disappear after adding a new one

**Files:** `src/server/routers/comics.router.ts` (~line 774-805)

The `getProject` query fetches project references from `comicProjectReference`. When a new reference is added, there may be a read-after-write consistency issue, or the query invalidation after the `addReferenceToProject` mutation isn't triggering a proper refetch on the frontend.

**Fix:** Same root cause as #8 — the fallback logic in `getProject` shows ALL user references when no junction rows exist. New comics have no junction rows, so they show everything. Once a new reference is added (creating the first junction row), only that one is returned. Fix by removing the fallback and only ever returning project-scoped references.

---

## 4. Default aspect ratio doesn't persist user selection

**Files:** `src/components/Comics/PanelModal.tsx`, `src/components/Comics/SmartCreateModal.tsx`

The aspect ratio defaults to `3:4` every time PanelModal or SmartCreateModal opens. There's no persistence of the user's last selection.

**Fix:** Store the last-used aspect ratio per project in `localStorage` (or in the project's `meta` field) and use it as the default when opening the modal. The project's `baseModel` already persists; aspect ratio should too.

---

## 5. Buzz currency: only Yellow Buzz is charged

**Files:** `src/server/routers/comics.router.ts` (panel creation, iterate, enhance)

All generation calls hardcode `currencies: ['yellow']`. Need to clarify product intent: should comics support Blue/Green buzz? On Civitai Green, the wrong amount is charged and it still uses Yellow.

**Fix:** Replace hardcoded `currencies: ['yellow']` with `getAllowedAccountTypes(ctx.features, ['blue'])` (same pattern used in the orchestrator router). This returns green/yellow as appropriate based on the user's context. When using yellow buzz, NSFW content restrictions should apply naturally through existing feature flags.
---

## 6. References randomly pulled into Smart Create

**Files:** `src/server/routers/comics.router.ts` (~line 3140-3164)

`smartCreateChapter` fetches ALL of the user's ready references (not project-scoped), then tries to filter by story mentions. References from other projects can leak in if their names happen to appear in the story text.

**Fix:** Scope the reference query to only fetch references linked to the current project (`comicProjectReference` junction). Fall back to user-wide references only if explicitly requested.

---

## 7. Remove reference from project doesn't work

**Files:** `src/server/routers/comics.router.ts` (~line 4783-4795)

The backend `removeReferenceFromProject` mutation appears correct (deletes from junction table). The issue is likely on the frontend - either the mutation isn't wired up, or the cache isn't invalidated after removal so the UI doesn't update.

**Fix:** Trace the frontend call site, confirm the mutation fires, and ensure proper query invalidation / optimistic update after removal.

---

## 8. New comics auto-pull references from old comics

**Files:** `src/server/routers/comics.router.ts` (~line 793-804)

The `getProject` query has backward-compat logic that shows ALL user references when no `comicProjectReference` junction rows exist. Since `createProject` doesn't create any junction rows, new projects inherit all references.

**Fix:** Remove the backward-compat fallback that shows all user references when no junction rows exist. Only return project-scoped references. This is the root cause of both #3 and #8 — fixing it here resolves both.
---

## 9. Smart Create panel count only accepts last digit

**Files:** `src/components/Comics/SmartCreateModal.tsx` (~line 164)

The `NumberInput` with `clampBehavior="strict"` has an input handling issue where typing multi-digit numbers (e.g., "12") only registers the last digit ("2").

**Fix:** The limit is 20 panels — the UX issue is that this isn't communicated clearly. Show the max limit near the input (e.g., "Max 20 panels") and switch `clampBehavior` to `"blur"` so typing isn't interrupted mid-keystroke. The input should clamp on blur, not on every keypress.
---

## 10. PDF export misses last 2 panels

**Files:** `src/components/Comics/ComicExportButton.tsx` (~line 106-122)

The export function fetches panel images sequentially and silently skips any that fail (`catch { // skip }`). If the last panels timeout or error, they're dropped without warning.

**Fix:** Add retry logic for failed fetches. Show a warning to the user if any panels were skipped. Consider fetching in parallel with `Promise.allSettled` for better reliability and speed.

---

## 11. Mod permissions: no download option, can't change ratings

**Files:** `src/components/Comics/comic-chapter.utils.ts`, public reader page `src/pages/comics/[id]/[[...slug]].tsx`

Mods should be able to download any comic and change NSFW ratings on panels/chapters. The `useChapterPermission` hook grants `canDownload` for mods, but the download UI may not be rendering. Rating change UI is missing entirely for mods.

**Fix:**
- Verify the download button renders when `canDownload` is true (check conditional rendering in the reader).
- Add a mod-only NSFW level selector on the reader/panel view, wired to the existing `setTosViolation` or a new rating mutation.
- Use the existing NSFW badge color definitions (already defined elsewhere in the codebase, not custom).
- Mods must ALWAYS be able to download — ensure the download button is unconditionally rendered for mods.
- Mods must be able to adjust a comic's NSFW level — follow the same pattern used for images/posts/etc.
---

## 12. Panel layout selection styling not obvious

**Files:** `src/components/Comics/LayoutPicker.tsx`

The selected layout uses `border-blue-500 bg-blue-500/10` which may not be prominent enough, especially in dark mode.

**Fix:** Increase contrast on the selected state - thicker border, stronger background opacity, or add a checkmark/highlight indicator.

---

## 13. Preview/read page is blank

**Files:** `src/pages/comics/project/[id]/read.tsx`

The project reader at `/comics/project/10/read` shows a blank page. Could be a query error, auth issue, or the project having no published chapters with ready panels.

**Fix:** Investigate the `getProjectForReader` query for project ID 10. Add proper empty/error states so the page never appears blank without explanation.

---

## 14. Iterative edit missing loading feedback

**Files:** `src/pages/comics/project/[id]/iterate.tsx`

After submitting an iterative edit, there's no spinner or progress indicator while the image generates. Refreshing in this mode is destructive (loses in-progress work).

**Fix:**
- Show a loading overlay/spinner while `iterateGenerateMutation` is pending. Disable/warn on navigation while generation is in progress.
- Also show a loading state while the full-resolution image loads (Nano images are large). Consider using preview/thumbnail versions in the feed first, similar to how `QueueItem` handles this.
---

## 15. Comics on Civitai Green: full run-through needed

Cross-cutting concern. Comics on `.green` need:
- Correct buzz currency (Green Buzz)
- Correct buzz amounts
- R-rated panel handling (block or filter on Green)
- General end-to-end testing

Mostly a manual testing pass. The buzz currency fix (#5) addresses the main code issue. The rest needs end-to-end validation on `.green`.
---

## 16. No way to generate images from within the Comic system

Users currently must generate images in the main generator first, then import them into a comic. The comic system should support direct image generation without leaving the workspace.

The issue is specifically about cover/hero images during initial comic creation. Panels and the create flow work fine. Users currently have to leave the comic system to generate a cover/hero in the main generator, then come back.

**Fix:** Add a "Generate Image" modal to the comic creation page. User enters a prompt, we submit one workflow, wait for the result, and use it as cover/hero. Reuse existing orchestrator submission logic. Inline generation would be ideal but a modal is simpler and sufficient for v1. Needs UX design for the interaction.
---

## 17. Landscape comics have excessive black space

The reader layout may not be optimized for landscape-oriented panels, showing too much empty space around them.

**Fix:** Check the reader CSS for how panel images are displayed. Landscape panels likely need a different max-width/aspect-ratio treatment than portrait ones.

---

## Suggested priority order

**High (core functionality broken):**
- 3+8: Reference scoping (one fix, resolves both)
- 1+2: Apostrophe/mention detection (one fix, resolves both)
- 7: Remove reference from project
- 6: Smart Create reference scoping
- 5: Buzz currency (use `getAllowedAccountTypes`)
- 10: PDF export missing panels

**Medium (mod tools, UX):**
- 11: Mod download + rating permissions
- 9: Smart Create panel count UX
- 13: Preview/read blank page
- 14: Iterative edit loading states
- 12: Layout picker selected styling
- 4: Aspect ratio persistence
- 17: Landscape layout spacing

**Larger scope (separate planning):**
- 16: Cover/hero image generation modal
- 15: Civitai Green end-to-end testing (manual)
