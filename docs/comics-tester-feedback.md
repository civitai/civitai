# Comic Tester Feedback — Implementation Status

ClickUp task: https://app.clickup.com/t/868hmbhq8
Branch: `fix/comic-tester-feedback`

## Implemented

1. **Chapter renumbering on delete** — When a chapter is deleted, remaining chapters are re-compacted to sequential positions (0, 1, 2...) using a temp-offset technique to avoid primary key conflicts.

2. **Page count per chapter in overview** — The chapter list now shows "X pages" next to each chapter name.

3. **Edit button on public comic page** — Owners see an Edit button that links to `/comics/edit/[id]`.

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

## Not Implemented — Feasibility Analysis

### Achievable with existing infrastructure (low-medium effort)

| Feedback | Effort | Details |
|----------|--------|---------|
| **Pick previously generated images for header** | Low | Same image picker as import tab, applied to cover/header image selection. |

### Requires significant new work (medium-high effort)

| Feedback | Effort | Details |
|----------|--------|---------|
| **Mod tools / Comics queue** | ~12-15 tasks | Report system works (`ComicProjectReport` exists, reports show in `/moderator/reports`). Missing: `tosViolation` field on schema, unpublish/block endpoints, dedicated `/moderator/comics.tsx` page, text moderation (Clavata) integration, and report-action workflow. Patterns exist for images/articles to copy from. |
| **Setting/art style reference** | Unknown | AI generation feature — needs orchestration/model changes and UX for style reference input. |
| **Feed panels from previous chapters** | Unknown | AI generation feature — needs orchestration changes to accept reference panels as context. |
| **Reference image tagging** (e.g. "@character with item") | Unknown | AI generation feature — needs UX + prompt engineering for tagged references. |
| **Comic images in user's posts/images** | TBD | Architecture decision on how comic panels relate to user gallery. Panels already have `imageId` FK to `Image` table, so the data relationship exists. |
| **PDF export** | Medium | Needs PDF generation service + creator permission controls + optional Buzz-gated download. |
| **Buzz-gated chapters / paywall** | Large | Major feature — payment flow, access control, Early Access integration, per-chapter pricing. |
| **More model options / price range** | Product decision | Needs product/pricing decision + orchestration config changes. |
| **Reactions on image panels** | Intentionally skipped | Testers specifically warned against this: "johnny civ is 100% going to fill someone's Romance Tragedy last panel with laughing face reacts" |
