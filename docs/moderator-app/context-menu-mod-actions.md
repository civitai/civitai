# Moderator actions removed from main-app context menus

As moderation moves to the moderator app (`apps/moderator`), **pure-moderator** actions get removed from
the main app's inline context menus (article/image/model/etc.). Author- and user-facing actions stay in
the main app. This is the running record of what's been pulled and what's still pending.

**Rule:** only remove an inline mod action once the spoke actually covers it — otherwise moderators lose
the path. When an inline mod action is removed and it was the *last* caller of a main-app
procedure/service, remove that orphaned backend chain too (grep-verified).

See also: the "Hard rules — spoke autonomy" section in
[tier1-backend-services-checklist.md](tier1-backend-services-checklist.md).

## `ArticleContextMenu` (`src/components/Article/ArticleContextMenu.tsx`)

| Action | Audience | Status | Notes |
|---|---|---|---|
| **Restore** | moderator | ✅ **Removed** 2026-07-01 | Covered by the spoke articles queue. Removed the whole orphaned chain: `article.restore` procedure, `restoreArticleHandler`, `restoreArticleById`, `restoreArticleSchema`/`RestoreArticleSchema`. |
| **Unpublish as Violation** | moderator | ⏳ Pending | No spoke equivalent yet — it acts on a *published* article (the entry point into the unpublished queue). Relocate to the spoke as a reports-queue action or a published-article lookup, then remove. |
| **Lock / Unlock Comments** | moderator | ⏳ Pending | No comment moderation in the spoke yet. Remove when that's built. |
| Delete | owner + moderator | Kept | Authors delete their own articles; the item stays. (Mod delete also exists in the spoke.) |
| Unpublish | owner | Kept | Author-facing (unpublish own published article). |
| Rescan | owner + moderator | Kept | Authors legitimately re-trigger a scan after fixing images. |
| Edit / Add to Collection / Add Art Frame / Toggle Searchable / Report | owner / user | Kept | Not moderation. |
