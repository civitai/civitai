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

## Not Implemented (require product decisions, backend/infra work, or are out of scope)

| Feedback | Why not done |
|----------|-------------|
| **Cover image cropping** | Needs image editor UI component + backend crop/resize pipeline |
| **Setting/art style reference** | AI generation feature — needs orchestration/model changes |
| **Feed panels from previous chapters** | AI generation feature — needs orchestration changes |
| **Reference image tagging** (e.g. "@character with item") | AI generation feature — UX + prompt engineering |
| **Generated images not appearing until refresh** | Likely needs WebSocket/polling in the comic editor — needs investigation into the editor's generation flow |
| **Mod tools / Comics queue** | Needs new moderation UI + backend queue integration |
| **More model options / price range** | Product/pricing decision + orchestration config |
| **Tips associated with comic** | Needs new tip entity association + earnings tracking |
| **Comic age rating** | Product decision on rating system, likely tied to browsing levels |
| **Comic images in user's posts/images** | Architecture decision on how comic panels relate to user gallery |
| **Reactions on comments** | Would need the existing reaction system wired to comic comment threads |
| **PDF export** | Needs PDF generation service + creator permission controls |
| **Buzz-gated chapters / paywall** | Major feature — payment flow, access control, Early Access integration |
| **Import images from generator** | Needs UI to browse user's generated images + import into comic panels |
| **Pick previously generated images for header** | Similar to above — image picker integration |
