# Step vs. workflow metadata: overwrite-or-merge

**Status:** Decided / implemented
**Related:** [docs/features/legacy-metadata-mapping.md](features/legacy-metadata-mapping.md), [docs/workflow-metadata-refactor.md](workflow-metadata-refactor.md)

> How the in-app generator decides whether a step's `params` replace or merge with the
> workflow-level form snapshot when reconstructing a generation for remix.

---

## Scope (what this is and isn't)

This doc is **only** about the in-app remix path, where generation data is split across two
layers on a live workflow object:

- `workflow.metadata.params` — the form-input snapshot for the whole submission.
- `step.metadata.params` — per-step data.

**Out of scope:** the EXIF `imageMetadata` we embed in generated images. That payload is already
a flat, correct, self-contained snapshot — remixing from an uploaded image reads it directly and
needs none of the two-layer reconciliation below. (We are explicitly **not** building a versioned
canonical-snapshot format, `kind` enum, AIR-vs-id scheme, etc. — `imageMetadata` doesn't have the
problem those would solve.)

---

## The problem

When you remix a generated output in-app, `BlobData.params` → `StepData.params` resolves the
output's params from the two layers. The question is what to do when the step carries its own
`params`:

- **Replace** (use step params verbatim), or
- **Merge** (layer step params over `workflow.metadata.params`)?

Getting this wrong is what caused the enhancement-remix bug (see
[workflow-metadata-refactor.md](workflow-metadata-refactor.md)): an upscale/remove-bg step stores
the **source generation's** params on the step, and `workflow.metadata.params` is the **enhancement
form** (`images:[sourceUrl]`, `upscaler`, `img2img:upscale`, …). Merging leaked those enhancement
fields into a remix of the original, so the remix behaved like the enhancement workflow.

---

## The rule: server flags the delta, client spreads it

`step.metadata.params` is one of three things, and a server-set flag — `partialParams` — tells the
client which, so the client never has to *decide*:

| Step kind | `step.metadata.params` | `partialParams` | Resolution |
| --------- | ---------------------- | --------------- | ---------- |
| Standard generation | absent (data lives on `workflow.metadata`) | — | fall back to workflow |
| Enhancement (upscale, remove-bg) | a **complete** snapshot of the source generation | — | use verbatim |
| Wildcard/snippet variant | a small **delta** (substituted prompt) | **`true`** | spread over workflow params |

`StepData.params` (in [workflow-data.ts](../src/shared/orchestrator/workflow-data.ts)) just applies
the flag:

```ts
const stepParams = this.metadata.params;
const wfParams = this.#workflow.metadata?.params;
// partial delta (flagged by server): spread the small delta over the workflow form snapshot
if (this.metadata.partialParams && stepParams && Object.keys(stepParams).length > 0) {
  return { ...wfParams, ...stepParams };
}
// otherwise either/or: complete snapshot verbatim, or workflow fallback
if (stepParams && Object.keys(stepParams).length > 0) return stepParams;
return wfParams ?? {};
```

### Why this split — and why the spread is on the client

- **The decision is server-side.** "Is this a partial delta?" is normalized into the `partialParams`
  flag by the server (set at the write site that produces the delta, passed through `formatStep`).
  The client contains no heuristic — it mechanically applies the flag.
- **The spread is client-side, on purpose.** If the server pre-merged, it would send a full copy of
  the params on *every* variant step — bloating the API response. Instead it sends the tiny delta +
  the flag, and the client completes it against `workflow.metadata.params` (which it already has).
- **`params` is never silently overloaded.** Without the flag, a step with params is a complete
  snapshot (used verbatim) — so an enhancement remix never leaks the enhancement form's fields
  (`images:[sourceUrl]`, `upscaler`, the `img2img:*` workflow key) into a remix of the original.

---

## Wildcards: the partial-delta case (plumbing implemented)

Snippet/wildcard variants store *only* the substituted fields (e.g. `prompt`/`negativePrompt`) per
step and rely on `workflow.metadata.params` for the full settings — a genuine partial **delta**. (The
wildcards *UI feature* isn't shipped yet, but the read/merge path below is wired so it Just Works once
wildcard generations are produced.)

- **Write** ([orchestration-new.service.ts](../src/server/services/orchestrator/orchestration-new.service.ts),
  snippet-variant loop): the per-variant overlay is written to `step.metadata.params` and the step is
  flagged `partialParams: true`.
- **Normalize** (`formatStep`): the delta is passed through **raw** (no `mapDataToGraphInput` — mapping
  a bare prompt delta would fabricate a workflow/ecosystem key), and `partialParams` is forwarded to
  `NormalizedStepMetadata`. The server does **not** pre-merge — it keeps the payload small.
- **Read** (`StepData.params`): spreads the delta over `workflow.metadata.params` (see the rule above).

Tradeoff: a partial step that *didn't* get flagged would be treated as a complete snapshot and used
verbatim, dropping the workflow settings — so the write path must set `partialParams` whenever it
writes a delta. We own both sides.

---

## History

This started as a `sourceLineage` boolean (server marks "complete snapshot → don't merge", with merge
as the *default*) — backwards polarity. We inverted it: **verbatim is the default**, and the rare
partial-delta producer (wildcards) flags itself with `partialParams: true`. We briefly tried a
dedicated `wildcards` key instead of a flag, but settled on the flag + `params` so the server can send
just the small delta and the client does the spread — minimizing the API payload while keeping the
decision server-normalized. The dead "Model A" source helpers
(`buildStepSource`/`resolveStepSource`) were removed in the same effort — see
[workflow-metadata-refactor.md](workflow-metadata-refactor.md).
