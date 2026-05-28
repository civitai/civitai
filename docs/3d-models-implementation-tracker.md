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

## Active agents — Wave 2 status

Wave 2 ran, several agents died mid-flight, recovered + merged what landed:

| Workstream | Status | Notes |
|------------|--------|-------|
| E | **DONE + merged** | 3 commits — NSFW propagation + Model3DMetric rollup + comment notifications |
| F | **DONE + merged** | Model3DGenerationForm, GenerationForm tab, QueueItem 3D branch, generate3D mutation, whatif preview |
| G (partial) | **partially merged** | Detail page rebuild + 4 components + review backend endpoints all done. **Remaining**: reviews page replacement + Post-from-Generation wiring (G2 spawned) |
| H (partial) | **partially merged** | 2 flags + surface gating done. **Remaining**: thumbnail-driven mod affordance (H2 spawned) |

## Active agents — Wave 2.5 (continuation) — DONE

| Workstream | Status | Notes |
|------------|--------|-------|
| G2: reviews page + post-from-gen | **DONE + merged** | 3 commits — reviews page (`6cc97db7a`), Post-from-Gen wiring + `getByWorkflowId` (`53a826201`), publish-hook flips Model3D Draft→Published (`8a9b1cf04`). Merged with import conflict resolved (H2's `getByThumbnailImageId` + G2's `getByWorkflowId` coexist). |
| H2: mod tooling | **DONE + merged** | 3 commits — `getByThumbnailImageId` procedure + `Model3DModAction` component + wired into `src/pages/moderator/images.tsx:655`. |

## ✅ Phase 1 complete

All 8 workstreams (A–H) merged on `main`. `pnpm run typecheck` clean across all Model3D code.

Phase 1 surface summary:
- Schema + migration applied
- Services: model3d / model3d-review / model3d-report
- Router: model3d (with `reviews` and `reports` sub-routers) + 12 procedures
- Orchestrator: PolyGen handler + Zod schema + generation-config registration
- UI: 3D Model generation form, queue card branch, detail page, reviews page, reviews modal
- Viewer: three.js + GLTFLoader (dynamic-imported)
- Jobs: NSFW propagation + Model3DMetric rollup + comment notifications
- Mod affordance: thumbnail-driven "Also unpublish parent Model3D"
- Feature flags: `model3d-feed` + `model3d-generator` (Flipt, mod-only at launch)
- Post-publish hook: linked Model3D auto-flips Draft → Published

Open follow-ups (intentionally deferred per plan):
- ClickHouse download event emission (Model3DMetric.downloadCount currently stays 0)
- Post-edit page surfacing Model3D-specific fields (currently passes `?model3dId=` through but doesn't render the form)
- Reviews pagination switched from page-based to cursor-based if scale demands it
- Dedicated `model3d` Meilisearch index implementation (search-parser is registered but routes nowhere yet)
- User uploads (Phase 3, schema is upload-ready)

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
