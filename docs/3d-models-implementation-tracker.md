# 3D Models Implementation — Live Tracker

**Purpose**: machine-death recovery surface + parallel-agent status board for Phase 1 implementation of `docs/3d-models-plan.md` (rev 9).

**How to use**: check this file to see what's been done, what's in flight, and what's next. Each agent commits its work to its own git worktree branch — branch names + paths are recorded below. If the machine dies, the worktree branches survive and the next session can pick up from the last recorded state.

**Task list (live)**: use the `TaskList` tool to see runtime status. This doc is the durable record.

---

## Phase 1 plan summary

Source of truth: `docs/3d-models-plan.md` rev 9. Migration already applied to user's DB. Prisma client regenerated (49 Model3D references in `prisma/schema.prisma`).

Workstreams (most are independent):

| ID | Workstream | Status | Worktree branch | Owner |
|----|------------|--------|-----------------|-------|
| A  | Backend foundation: `model3d.service.ts`, `model3d.router.ts`, `model3d-review.service.ts` | pending | — | — |
| B  | Orchestrator PolyGen: `polygen.schema.ts` (Zod), `polyGen.handler.ts`, `generation.config.ts` registration | pending | — | — |
| C  | Existing-file touch points: `ReportEntity` / `SearchIndexEntityTypes` / `commentv2.schema.ts` / `buzz.schema.ts` / `image-scan-result.ts` enum + allow-list edits | pending | — | — |
| D  | UI scaffold: install three.js, build `Model3DViewer` component, scaffold `/3d-models/[id]` page stub | pending | — | — |
| E  | Jobs + notifications: `updateModel3DNsfwLevels`, `updateModel3DMetrics`, comment notification SQL | pending (depends on A) | — | — |
| F  | Generation form integration: add 3D Model tab to `GenerationForm.tsx`, build text-to-3D + image-to-3D sub-tabs | pending (depends on B) | — | — |
| G  | "Post from Generation" + detail page + reviews modal | pending (depends on A, D) | — | — |
| H  | Feature flags + mod tooling | pending | — | — |

---

## Recovery protocol

If the main session dies:

1. **Check this doc** for the last recorded status of each workstream.
2. **`git branch | grep model3d-`** to find live agent worktree branches.
3. **`git worktree list`** to see active worktrees and their paths.
4. **`git log --all --oneline | grep -i 'Model3D\|model3d'`** for recent commits.
5. For each in-flight workstream, the worktree branch contains the agent's progress. Either:
   - Resume by spawning a new agent with the same brief + worktree path
   - Or merge the worktree's branch into `main`/feature branch and continue manually
6. **Run `pnpm run typecheck`** in the main worktree to spot anything broken by merged work.

---

## Active agents — Wave 2 (in flight)

| Workstream | Status | Scope |
|------------|--------|-------|
| E: Jobs + notifications | **in flight (background)** | updateModel3DNsfwLevels + updateModel3DMetrics + 3 comment notifications + threadUrlMap entry |
| F: Generation form | **in flight (background)** | 3D Model tab in GenerationForm, Model3DGenerationForm.tsx, queue card (thumbnail-only), `generate3D` tRPC mutation, whatif cost preview |
| G: Detail page + reviews modal | **in flight (background)** | Full detail page rebuild on `/3d-models/[id]`, Model3DReviewModal with image attachments via Post.model3dReviewId, reviews page, Post-from-Generation wiring |
| H: Feature flags + mod tooling | **in flight (background)** | model3dFeed + model3dGenerator Flipt flags, thumbnail-driven "Also unpublish parent Model3D" mod affordance |

## Active agents — Wave 1 (done, merged)

See "Commit log" below.

## Integration plan (once C lands)

Merge order: **D → B → C → A** (least conflict risk; A touches the most, lands last).

1. `cd /home/luis_rojas/Work/civitai`
2. `git merge --no-ff worktree-agent-a7e6b0ab4d05237b9` (D)
3. `pnpm install` (picks up three.js)
4. `git merge --no-ff worktree-agent-a240a7c10f27a2a52` (B)
5. `git merge --no-ff worktree-agent-ad3d34f1b06bd20c6` (C — once committed)
6. `git merge --no-ff worktree-agent-a032ad75027b491bc` (A)
7. Reconcile B's `upsertModel3DDraft` TODO → A's actual `upsertModel3D` shape (one-line edit in `polyGen.handler.ts`)
8. `rm src/pages/3d-models/[id]/.gitkeep`
9. `pnpm run typecheck` (expect 0 new errors; pre-existing main errors unchanged)
10. `pnpm run lint`
11. `git commit -am "feat(model3d): integrate Phase 1 wave 1 (workstreams A, B, C, D)"`
12. `git worktree remove` each worktree (cleanup)

## Monitoring commands

```bash
# Live task status (runtime, in-conversation)
# Use the TaskList tool in the assistant session.

# Worktrees + branches survive across machine restarts:
git worktree list
git branch | grep -i model3d

# Recent commits across all branches:
git log --all --oneline --since="1 hour ago" | head -30
```

---

## Commit log (post-merge)

| Date | Workstream | Branch merged | Notes |
|------|------------|---------------|-------|
| 2026-05-27 | groundwork | (main) `2f7b86a7a` | schema + migration + docs + civitai-client bump |
| 2026-05-27 | D | `worktree-agent-a7e6b0ab4d05237b9` @ `9efe10370` | three.js + viewer + 3 page stubs |
| 2026-05-27 | B | `worktree-agent-a240a7c10f27a2a52` @ `8ff736a52` | PolyGen schema + handler + generation.config registration |
| 2026-05-27 | C | `worktree-agent-ad3d34f1b06bd20c6` @ `dc27eb04d` | 10 touch-point files (enums, allow-lists, collection.utils, job-queue, user.service) |
| 2026-05-27 | A | `worktree-agent-a032ad75027b491bc` @ `5c60f5645` | services + router + Zod + router registration |
| 2026-05-27 | reconcile A↔B | (main) `4e8570350` | added upsertModel3DFromWorkflow; wired polyGen.handler.ts; `currencies: []` for WorkflowTemplate |

**Phase 1 Wave 1 complete. `pnpm run typecheck` passes.**

---

## Next steps after Phase 1 lands

- Apply the migration to the next environment (staging/prod) per user request.
- Phase 2: feed broadening, profile tab, community "Makes/Uses" Post linkage.
- Phase 3: user uploads (deferred; schema is upload-ready).
