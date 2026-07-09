# BIG ONE — Fetch Training Data from the Orchestrator

**Status:** Design / scoping (no code yet) · **Owner:** Luis · **Ticket:** Training Revisions (868k1qape)

> Ticket item, verbatim:
> - **BIG ONE: Fetch Training Data from Orch**
>   - Update Review Page to use Orch
>   - Replace all stuff stored in DB

This document scopes the change before any implementation, per the request to "scope it first." All file references were verified against the `worktree-training-revisions` branch.

---

## 1. Problem statement

The training wizard's **run configuration** — base model, engine, all training params, sample prompts, negative prompt, audio overrides — lives **only in an in-memory Zustand store** (`useTrainingImageStore`). There is no persistence middleware. So when a user refreshes the page or resumes a draft, the store is empty and the run is re-defaulted.

Two user-visible symptoms:

1. **Sample prompts (and param tweaks) vanish on refresh/resume of Step 3.** This is the "Sample Prompts should be repopulated on final step refresh/resume" line of the same ticket — it's the same root cause.
2. The Review Page (Step 3) shows freshly-defaulted values rather than what the user actually configured / previously submitted.

"Fetch Training Data from Orch" = on resume, recover the run config from the source of truth instead of re-defaulting it. "Replace all stuff stored in DB" = move the source of truth for a *submitted* training from the `ModelVersion.trainingDetails` DB blob to the orchestrator workflow (with the DB kept as a mirror/fallback).

---

## 2. Current-state data map

| Data | Stored where today | Written by | Read by |
|---|---|---|---|
| `runs[]` (base, baseType, customModel, params, samplePrompts, samplesOverrides, negativePrompt, highPriority, staging, buzzCost, hasIssue) | **Zustand only** (in-memory) | `training.store.ts` mutators (`updateRun`/`addRun`/`resetRuns`) | `TrainingSubmit.tsx`, `AdvancedSettings`, `ModelSelect` |
| `TrainingRun` type | — | `src/store/training.store.ts:122-136` | — |
| Persisted training config | `ModelVersion.trainingDetails` JSON (`TrainingDetailsObj`) — `src/server/schema/model-version.schema.ts` (~`:242-269`) | submit handler `TrainingSubmit.tsx` (~`:748-769`, `upsertVersionMutation`) | `TrainingSubmit.tsx` reads only `mediaType` / `type` / `continueFromEpoch`; `training.orch.ts` reads it to build the orch step (~`:274-291`) |
| File / dataset metadata (`numImages`, `numCaptions`, `labelType`, `ownRights`, `shareDataset`) | `ModelFile.metadata` (`FileMetadata`) | `TrainingImages.tsx` | `TrainingImages.tsx`, `TrainingSubmit.tsx` |
| Completed-run results (`workflowId`, `epochs`, `sampleImagesPrompts`, history) | `ModelFile.metadata.trainingResults` (`TrainingResultsV2`) — `model-file.schema.ts` (~`:45-80`) | orchestrator webhook / `training.orch.ts` (~`:425`) | review / epoch picker |
| Resume rehydration of imageList / labelType / triggerWord / ownRights / shareDataset | from DB on Step 2 mount | `TrainingImages.tsx` (~`:995-1040`) | store |
| **Run rehydration (base/params/prompts)** | **— none —** | **nothing restores `runs`** | — |

**The gap:** `TrainingImages.tsx` (~`:995-1040`) rehydrates everything *except* `runs`, and `TrainingBasicInfo.tsx` (~`:334-335`) calls `resetRuns(...)` which re-defaults them. The only run field re-seeded today is `continueFrom`, via the `continueFromEpoch` workaround in `TrainingSubmit.tsx` (~`:148-163`) — which confirms the team already hit this limitation and patched the one field that hurt most.

---

## 3. What the orchestrator can / can't return

**A fetch path already exists — no new orchestrator endpoint needed to read a submitted run:**

- tRPC `orchestrator.getWorkflow` — `src/server/routers/orchestrator.router.ts` (~`:256-261`)
- service `getWorkflow` — `src/server/services/orchestrator/workflows.ts` (~`:86-120`)
- Returns the full workflow including each step's `input` (the params we sent) and `output` (epoch results).

**Recoverable from the orchestrator workflow** (for a previously-submitted version):

- base model AIR, engine, full training params
- sample prompts + `sampleCfgScale` + `sampleStrength` (sent in `samples`), negative prompt
- `continueFrom`, trigger word, image count
- epoch outputs / sample image prompts of the completed run

**NOT recoverable from the orchestrator:**

- **`saveEvery`** — it is a UI-only knob and was never sent for AI Toolkit (`training.orch.ts` ~`:165-167,188-189`). (Note: as part of this same ticket, "Save every" is being replaced by a **Checkpoints** count bound to `maxTrainEpochs`/`epochs`, which *is* sent — so this gap shrinks going forward.)
- `staging`, `hasIssue`, `buzzCost` (client/whatIf-side only)
- the **multi-run editor list** (the orchestrator only knows about runs that were actually submitted as workflows; the in-progress multi-run editor state is client-only)
- **anything for a draft that was never submitted** — there is no workflow yet, so nothing to fetch.

This last point is the crux of the architecture: **"new draft" vs. "previously submitted/resumed" are two distinct paths.**

---

## 4. Proposed target architecture

**Source of truth, post-change:**

| Situation | Source of truth | Fallback |
|---|---|---|
| Draft never submitted (no `workflowId`) | Zustand store (as today) | — |
| Previously submitted / resumed | Orchestrator workflow `input` | `ModelVersion.trainingDetails` (DB mirror) → store defaults |

**Branch on `workflowId`** (available via `trainingResults.workflowId` in file metadata): if present, the version has been submitted at least once and the orchestrator can be queried; if absent, treat as a fresh draft.

**Rehydration flow (Step 3 mount):**

1. If the store already has a populated run for this model (user is mid-session), do nothing.
2. Else if a `workflowId` exists → call `orchestrator.getWorkflow`, map its `input` back into a `TrainingRun`, seed the store.
3. Else if `trainingDetails` exists in the DB → map it into a `TrainingRun`, seed the store. (Covers in-flight/older versions and graceful degradation when the orch call fails.)
4. Else → defaults (today's behavior).

**"Replace all stuff stored in DB"** is best read as: *stop treating `trainingDetails` as the authoritative store and treat the orchestrator as authoritative for submitted runs, with the DB as a mirror/cache.* A hard removal of the `trainingDetails` column is **not** recommended (it's the only fallback for older versions and for the brief window before a workflow exists) — phase that separately, if ever.

---

## 5. Migration & risk

- **Backward compatibility:** versions whose data lives only in `trainingDetails` (created before this change, or in-flight) must still rehydrate. Step 3 of the flow above handles this. Do **not** drop `trainingDetails` in this work.
- **DB migration:** none required for Phase 1 (read-only rehydration). If a later phase changes the schema, remember **this repo applies migrations manually — never `prisma migrate deploy`** (see CLAUDE.md). Write the SQL, commit it, and surface it for manual application.
- **Pricing:** params drive cost (`steps` → pricing; `epochs` = checkpoints). Rehydrating must not silently change a previously-quoted cost; re-run the whatIf after rehydration and show the user the current quote.
- **Failure modes (must degrade gracefully):**

  | Failure | Behavior |
  |---|---|
  | `getWorkflow` errors / times out | Fall back to `trainingDetails`, then to defaults; never block the page |
  | Workflow exists but `input` shape drifted from current schema | Validate with zod; on mismatch, fall back to DB and log |
  | Draft with no workflow | Skip orch entirely (expected, not an error) |
  | `saveEvery` absent from orch | Derive from `steps / checkpoints` (already the UI behavior post-ticket) |

---

## 6. Phased implementation plan

**Phase 1 — Rehydrate the store from the DB on Step 3 mount (low risk, fixes the bug now).**
- Map `trainingDetails` → `TrainingRun` and seed the store if no live run exists.
- Fixes "sample prompts repopulate on refresh/resume" immediately, with no orchestrator dependency.
- Files: `TrainingSubmit.tsx` (mount effect), a small `trainingDetails → TrainingRun` mapper (new util), `training.store.ts` (a `hydrateRun`/seed mutator). Effort: **S–M**. Risk: **low**.

**Phase 2 — Add orchestrator rehydration for submitted versions.**
- When `workflowId` exists, prefer `orchestrator.getWorkflow` `input`; fall back to Phase 1's DB path.
- Files: `TrainingSubmit.tsx`, new mapper `workflow.input → TrainingRun`, reuse `orchestrator.getWorkflow`. Effort: **M**. Risk: **medium** (input-shape mapping).

**Phase 3 — Make orchestrator the source of truth on the Review Page.**
- Review Page reads run config via the rehydrated store (now orch-backed) rather than re-reading `trainingDetails`. DB writes become a mirror.
- Files: `TrainingSubmit.tsx`, possibly `training.service.ts`. Effort: **M**. Risk: **medium**.

**Phase 4 (optional / later) — Reduce DB reliance.**
- Stop writing redundant fields to `trainingDetails`; keep only what's needed as a fallback/index. Only after Phases 1–3 are proven in prod. Effort: **M–L**. Risk: **high** (touches persistence + pricing history). Requires its own migration review.

**Recommendation:** ship **Phase 1** as part of this ticket (it closes the visible bug). Treat Phases 2–4 as follow-ups gated on review.

---

## 7. Open questions for the team

1. Is "Replace all stuff stored in DB" meant literally (drop `trainingDetails`), or "make orch the source of truth, DB as mirror"? This doc assumes the latter.
2. For the **multi-run editor**, the orchestrator only knows submitted runs. On resume of a multi-run draft, do we restore all runs from the most recent submit, or only the selected one?
3. Should rehydration **overwrite** a user's in-session edits if they navigate back to Step 3, or only seed when the store is empty? (This doc assumes seed-only.)
4. After rehydration, do we re-run the whatIf automatically (re-quote cost) or wait for an explicit user action?
5. For older versions with only `trainingDetails` and no workflow, is the DB→`TrainingRun` mapping considered authoritative indefinitely?
6. `saveEvery` is being retired in favor of a Checkpoints count this same ticket — confirm we don't need to preserve legacy `saveEvery` semantics for already-submitted runs.
7. Any versions mid-training (workflow running) where we must NOT let the user re-submit different params? Should the Review Page be read-only in that state?
8. Privacy/permissions: does `orchestrator.getWorkflow` enforce that the requesting user owns the workflow? Confirm before wiring it into the resume path.
