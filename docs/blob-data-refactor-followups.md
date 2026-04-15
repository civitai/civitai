# BlobData Refactor — Follow-ups

Context: we converted `BlobData` from a single concrete class into an abstract base with three concrete subclasses (`ImageBlob`, `VideoBlob`, `AudioBlob`), replaced per-blob `status` with `available` + `step.status`, and renamed `images` → `output` at the class/wire layer. The items below are the loose ends that weren't in scope for that pass.

Primary files:
- [src/shared/orchestrator/workflow-data.ts](../src/shared/orchestrator/workflow-data.ts)
- [src/server/services/orchestrator/orchestration-new.service.ts](../src/server/services/orchestrator/orchestration-new.service.ts)

---

## 1. Generic `BlobData<T>` for subclass props

**Where:** [workflow-data.ts](../src/shared/orchestrator/workflow-data.ts) — abstract `BlobData` class + `ImageBlob` / `VideoBlob` / `AudioBlob`.

**What:** Each subclass currently re-declares its extra fields (`width`/`height`/`aspect` on Image and Video; `duration` on Audio). Explore whether a generic `BlobData<TExtra>` where `TExtra` describes the subclass-only shape would eliminate the per-subclass boilerplate.

**Sketch:**
```ts
abstract class BlobData<TExtra = {}> {
  readonly type!: 'image' | 'video' | 'audio';
  url!: string;
  // ...shared fields
}

class ImageBlob extends BlobData<{ width: number; height: number; aspect: number; previewUrl?: string | null; previewUrlExpiresAt?: string | null }> {
  readonly type = 'image' as const;
}
```

**Tradeoffs to settle:**
- TypeScript won't auto-promote `TExtra` into instance properties — you'd need `implements` on the subclass or a mapped-type merge, and `Object.assign(this, data)` still does the runtime work. May not actually reduce boilerplate.
- Harder for callers to read the class at a glance (fields are in the type parameter, not the class body).
- Worth prototyping before committing.

---

## 2. ~~`BlobData.workflow` non-null assertion~~ — **Resolved**

`StepData` constructor now takes `workflow: WorkflowData` as a required parameter (was `wfMetadata?`, `workflow?` previously). `StepData.#workflow` is non-optional, `StepData.workflow` returns `WorkflowData` (not `| undefined`), and `BlobData.workflow` no longer needs `!` — the invariant "every blob has a workflow" is now enforced at the type level.

Notes:

- `_setWorkflow` escape hatch kept for the rebuild path in `WorkflowData` ctor (existing StepData instances can be re-parented onto a new WorkflowData during immer-style updates).
- Tests in [workflow-metadata.test.ts](../src/server/services/orchestrator/__tests__/workflow-metadata.test.ts) updated to construct a bare `WorkflowData` via a `makeWorkflowData()` helper.

---

## 3. `AudioBlob` aspect default vs. `OutputBlob` intermediate

**Where:** [workflow-data.ts — `AudioBlob`](../src/shared/orchestrator/workflow-data.ts)

Currently `AudioBlob` has `readonly aspect = 1` as a convenience for consumers that generically read `.aspect` across the blob union. The original thought was to introduce an `OutputBlob` intermediate class between `BlobData` and `ImageBlob`/`VideoBlob`/`AudioBlob` that holds `aspect` with a default of 1.

**Decide:**
- Keep `aspect = 1` on `AudioBlob` only (current state, minimal).
- Or hoist to an intermediate class (`OutputBlob` or similar) with a default of 1, which audio inherits and image/video override with real values.

Low priority — current state works. Revisit only if another cross-type property appears with a similar "sensible default for one variant" pattern.

---

## 4. ~~`step.metadata.images` wire key rename~~ — **Resolved (dual-key)**

Landed approach (none of the originally proposed options):

- **Server passes both keys raw.** [`NormalizedStepMetadata`](../src/server/services/orchestrator/orchestration-new.service.ts) declares both `output` (current) and `images` (legacy). `formatStep` emits whatever the orchestrator stored under each key — no merging, no migration. New writes land under `output`; legacy state stays under `images`.
- **Client merges for display.** [`BlobData.outputMeta`](../src/shared/orchestrator/workflow-data.ts) returns `{ ...legacy, ...current }` per-blob — current key wins per-field, legacy fields not yet rewritten still show through.
- **Client writes `output/*`.** [`generationRequestHooks.ts`](../src/components/ImageGeneration/utils/generationRequestHooks.ts)'s jsonPatch builder targets `output/*`. The orchestrator's strict ASP.NET typed jsonpatch accepts these (the DTO has both `output` and `images` properties), and rejects writes to a path whose parent doesn't yet exist — so the client emits init ops (`add path:'output' value:{}`, `add path:'output/${id}' value:{}`) when the **raw** `output` is missing on the orchestrator. Decision is based on raw `output`, not merged.
- **Optimistic update + tag sync use the merged view.** Otherwise the post-patch state would think a legacy-liked workflow has no liked images and would strip the `feedback:liked` tag from the workflow.
- **Filter-cache pruning.** `updateImages` now removes workflows from caches whose filter tags they no longer match (e.g. unliking the last liked image while filtered to "liked").

Why we didn't migrate: data loss was a non-starter, and the orchestrator's typed-patch rejected the bulk migration op anyway. The dual-key path keeps both old and new workflows working without any backend coordination.

Future cleanup (not urgent): a one-shot backfill job to rewrite `metadata.images` → `metadata.output` on all workflows. Once everything's under `output`, remove the legacy reader (`legacyImages` lookup in `BlobData.outputMeta` and `updateImages`) and drop `NormalizedStepMetadata.images`. No rush — the legacy shim is small, contained, and self-healing in the sense that any post-rename write to a workflow leaves that workflow's `output` key populated for future reads.

---

## 5. `Object.assign(this, data)` type/runtime gap

**Where:** [workflow-data.ts — `BlobData` constructor](../src/shared/orchestrator/workflow-data.ts)

```ts
constructor({ data, ...opts }: BlobConstructorArgs) {
  Object.assign(this, data);
  // ...
}
```

**Problem:** `Object.assign` is how every blob field gets populated (id, url, width, height, previewUrl, duration, etc.). TypeScript can't see the assignment, which is why the class declares `url!: string`, `id!: string`, `available!: boolean`, etc. with definite-assignment assertions. Implications:
- If `NormalizedImageOutput` adds a field on the wire, the instance silently carries it even without a class declaration — unreachable from typed reads.
- If a subclass declares a field the wire shape doesn't provide, the field is silently `undefined` at runtime — no compile error.
- The class hierarchy and the normalized wire types (`NormalizedImage/Video/AudioOutput`) are two sources of truth kept in sync by hand. `satisfies` annotations in `formatStepOutputs` cover the *emission* half; nothing covers the *consumption* half.

**Options:**
1. **Explicit field copy** — in each subclass ctor, assign only the fields the class declares. Kills the silent-field-drift problem at the cost of ctor boilerplate.
2. **Derive one from the other** — generate the class-field declarations from the wire type (or vice versa) so drift is a compile error. Non-trivial — would likely need a codegen step or a heavy conditional-type utility.
3. **Accept it, add guardrails** — write a runtime test that instantiates each subclass from a fully-populated wire payload and asserts every declared field got a value. Catches drift at test time, not compile time.
4. **Leave it.** Current state. The `!` assertions are honest *today*; any drift becomes a bug for future-us.

**Recommendation:** Start with option 3 (cheap, catches the most common drift case). Promote to option 1 if drift bugs actually materialize.

---

## 6. `_setWorkflow` re-parenting escape hatch

**Where:** [workflow-data.ts — `StepData._setWorkflow`](../src/shared/orchestrator/workflow-data.ts); called from the `WorkflowData` constructor when `rawStep instanceof StepData`.

**Context:** A `WorkflowData` can be re-constructed from a prior `WorkflowData`'s `steps` array (e.g. during immer-style query-cache mutations). When that happens, existing `StepData` instances are reused — but their `#workflow` reference still points at the old `WorkflowData`. `_setWorkflow(this)` rewires them onto the new parent.

**Problem:** `_setWorkflow` is mutation-in-disguise. Consumers holding a reference to a StepData can have its workflow replaced out from under them without notice. The `#private` field makes this invisible at the type level.

**Options:**

1. **Keep it.** Current state. Acceptable because the only caller is `WorkflowData`'s own ctor, and the replacement is always onto a structurally-equivalent workflow (same id, same metadata snapshot). Low risk in practice.
2. **Collapse to always-fresh construction.** Drop `_setWorkflow`; the `WorkflowData` ctor always constructs new `StepData` instances (and therefore new `BlobData` instances) even when the input contains pre-wrapped StepData. Simpler invariant, at the cost of re-wrapping every blob on every workflow mutation. Measure perf first — if cache-update churn is hot, this is expensive.
3. **Immutable reconstruction.** Expose a `StepData.withWorkflow(workflow)` method that returns a *new* StepData sharing the same underlying fields and output array but with a different `#workflow`. The `WorkflowData` ctor calls this instead of mutating. Middle ground — cheap and no hidden mutation.

**Recommendation:** Option 1 until we measure. Option 3 if we ever want to hand StepData references to code that shouldn't see mutations.

---

## 7. `available: false` post-step-success — investigate orchestrator behavior

**Where:** observed in aceStepAudio workflows; see the error-card handling in [GeneratedOutputWrapper.tsx](../src/components/ImageGeneration/GeneratedOutputWrapper.tsx).

**Context:** During the refactor we observed workflows where `step.status === 'succeeded'` but the step's output blob has `available: false`. We surfaced this in the UI as an error card (`BlobData.errored` getter + wrapper render branch), but the underlying cause wasn't investigated.

**Questions:**

- Is `available: false` after step-success a genuine terminal failure (worker produced no output), or a transient "post-processing in progress" state that the orchestrator resolves later?
- If transient, what's the expected window, and should clients poll / re-query instead of showing an error card immediately?
- Does this happen only for `aceStepAudio` (which has an unusual blob lifecycle — the audio/video is assembled after the job reports done), or for other step types too?

**Action:** Open a ticket against the orchestrator team. If transient, we may want to delay the error card (e.g. only show after N seconds of `succeeded + !available`) or drive it off a different signal entirely.

---

## 8. ~~`GeneratedImage.stories.tsx` — rename / realign~~ — **Resolved**

Renamed to [`GeneratedOutput.stories.tsx`](../src/components/ImageGeneration/GeneratedOutput.stories.tsx). Internal symbols updated (`GeneratedImagePreview` → `GeneratedOutputPreview`, `ImageCard` → `OutputCard`) and stale "image" copy in the placeholder swapped to "output". Kept the standalone-mock approach (option (a)) — the file's leading comment explicitly calls out "without Next.js dependencies", and rendering the real `GeneratedOutput` would require mocking workflow data, intersection observer, tRPC mutations, tour context, and the generated-item store.

---

## Out of scope (already done, noted here for closure)

- `BlobData.status` getter — **removed**; callers migrated to `available` / `step.status`.
- `imageMeta` → `outputMeta` on `BlobData` — **renamed**.
- "images" → "output(s)" across class getters and doc comments — **done** on the client API surface.
- Old wrapper files (`GeneratedImage.tsx`, `GeneratedImageLightbox.tsx`, `Blob*.tsx`) — **deleted**; consumers updated.
- Component renames (`Blob*` → `GeneratedOutput*`) — **done**.
- `workflowId` / `stepName` / `jobId` on normalized wire type — **dropped** (derived via parent refs or unused).
- `previewUrl` / `previewUrlExpiresAt` — **moved** to `NormalizedImageOutput` / `ImageBlob` only.
- Legacy `metadata.images` → `metadata.output` — **dual-key with client-side merge** (see item 4); writes go to `output`, reads merge both.
- Optimistic-update tag-sync regression on legacy workflows — **fixed**: tag-sync now operates on the merged post-patch state.
- Filter-cache pruning in `updateImages` — **added**: workflows that no longer match a cache's filter tags are dropped from that cache.
- `GenerationProvider` queue tracking across filter changes — **fixed**: now uses `ignoreFilters: true` so queue/canGenerate/hasGeneratedImages reflect all in-flight workflows.
- `BlobData.errored` + UI error card for `step.status === 'succeeded' && !available` — **added** (still pending root-cause investigation; see item 7).
