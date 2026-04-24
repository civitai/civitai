# Auto-Label (Caption / Tag) Revamp — Orchestrator v2 Workflows

## Background

The current training auto-caption / auto-tag system zips images, uploads to S3, calls a legacy orchestrator job API, and listens for results via the `orchestrator:workflow-update` signal handler in `TrainingCommon.ts`. That service and the signals path have been failing recently, so we're moving the pipeline to the v2 orchestrator (presigned blob upload + workflow submission).

End-to-end target flow:

1. User clicks **Auto-Label** in `TrainingAutoLabelModal`.
2. Frontend asks our tRPC layer for a presigned upload URL **per image** (system-token issued).
3. Frontend `POST`s each image directly to that URL — no zip, no S3 round-trip.
4. Frontend submits a workflow (1 step per image, up to 16 per workflow) via tRPC; we forward to the orchestrator with the **system token**.
5. Frontend polls workflow status via tRPC until each step is `succeeded` / `failed`.
6. Frontend applies blacklist / prepend / append / threshold post-processing locally, then writes the resulting label back to the image store.

## Constraints we're designing to

- Upload happens **from the browser**, not the server — so the frontend needs the presigned URL.
- Tagging/captioning is **free**; the workflow must be submitted with the **system** token (`env.ORCHESTRATOR_ACCESS_TOKEN`), not the user's token. Because of that, the user can't read the workflow with their own token — reads also have to go through a tRPC wrapper.
- The orchestrator does **not** apply blacklist / prepend / append. Frontend stashes those in workflow `metadata` and applies them when reading results.
- Up to **16 images per workflow** (one step per image) as a soft target — no orchestrator hard limit, but it slots cleanly onto the orch's 64-tasks-per-GPU budget while still letting other workflows in. Larger sets get split into multiple workflows submitted in parallel; the batch size lives as a constant we can tune.
- We'll **poll** the workflow (per the example) rather than wire signals — system-token workflows don't carry user context, so the existing `orchestrator:workflow-update` signal wouldn't reach the user without extra plumbing. Keep it simple.

## Existing scaffolding to reuse

- `src/server/services/orchestrator/consumerBlobUpload.ts` — already wraps `getConsumerBlobUploadUrl` from `@civitai/client`. Currently uses the **user** token and is exposed via a legacy `/api/orchestrator/getConsumerBlobUploadUrl` endpoint, **not** tRPC. We need a new tRPC entry that uses the system token.
- `src/server/services/orchestrator/client.ts` — `internalOrchestratorClient` is built with `env.ORCHESTRATOR_ACCESS_TOKEN`. Use this for everything in this revamp.
- `@civitai/client` exports we'll lean on: `getConsumerBlobUploadUrl`, `submitWorkflow`, `getWorkflow`, plus the step types `MediaCaptioningStepTemplate` and `WdTaggingStepTemplate`.
- `applyTagPostProcess` / `applyCaptionPostProcess` — these don't exist yet; we'll extract the existing post-processing logic out of the `useOrchestratorUpdateSignal` callback in `TrainingCommon.ts` so it's reusable from the new helper.

## Phase 1 — Server: three new tRPC procedures (under `training`)

All three live in `src/server/services/training.service.ts` + `src/server/routers/training.router.ts`. Schemas in `src/server/schema/training.schema.ts`.

### 1. `training.getAutoLabelUploadUrl` *(mutation, authed)*

- Calls `getConsumerBlobUploadUrl` via `internalOrchestratorClient` (system token).
- Returns `{ uploadUrl, expiresAt }`.
- Rate-limit per user (defensive — they could spam).

### 2. `training.submitAutoLabelWorkflow` *(mutation, authed)*

- Input:
  ```ts
  {
    modelId: number,
    type: 'caption' | 'tag',
    images: { mediaUrl: string, filename: string }[],   // max 16
    params: CaptionParams | TagParams,                  // temp/maxNewTokens OR threshold
    postProcess: {
      blacklist?: string[],          // capped — see schema (e.g. 200 entries, ~50 chars each)
      prependTags?: string,
      appendTags?: string,
      maxTags?: number,
      threshold?: number,
      overwrite: 'append' | 'overwrite' | 'ignore',
    }
  }
  ```
  Cap is defensive — real usage of blacklist has stayed small. Reject oversized payloads at the Zod layer with a clear error.
- Builds a workflow body:
  - One step per image (`mediaCaptioning` or `wdTagging`).
  - Each step's `metadata` carries the original `filename` so the frontend can match results back to images.
  - Workflow `metadata` carries `{ modelId, mediaType, type, postProcess }` — server doesn't apply post-process, but storing it makes the workflow self-describing for debugging and means the polling endpoint doesn't need a second store.
- Submits via `internalOrchestratorClient.submitWorkflow({ body, query: { wait: 0 } })`.
- Returns `{ workflowId, stepCount }`.
- **Authorization check**: confirm the calling user owns `modelId` (re-use the ownership check used by `autoTagHandler`).

### 3. `training.getAutoLabelWorkflow` *(query, authed)*

- Input: `{ workflowId }`.
- Reads the workflow via system token (`internalOrchestratorClient.getWorkflow(workflowId)`).
- Authorization: parse `workflow.metadata.modelId` and check ownership before returning. Otherwise any user could poll any workflow ID.
- Returns a trimmed shape: `{ status, steps: [{ filename, status, output }], cost, completedAt }` so we don't leak presigned URLs back to the client unnecessarily.

> **Why a server wrapper for reads?** System token = workflow not visible to the user's token. Wrapping it via tRPC lets us also enforce per-model ownership.

## Phase 2 — Frontend: new client module + modal rewrite

### New: `src/utils/training/auto-label-orchestrator.ts`

A small client helper that owns the upload + submit + poll dance:

```ts
type AutoLabelTask = {
  workflowId: string;
  pollHandle: () => void;        // cancel
};

uploadAndSubmitAutoLabel({
  modelId, type, images, params, postProcess,
  onProgress: (uploaded, total) => void,
  onResult:   (filename, output) => void,
  onDone:     (summary) => void,
  onError:    (err) => void,
}): Promise<AutoLabelTask>
```

Inside it:

- Chunk `images` into batches of 16.
- For each image: call `training.getAutoLabelUploadUrl`, then `fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': mimeType }, body: blob })`. Track upload progress.
- Per batch: `training.submitAutoLabelWorkflow(batch)` → workflow ID.
- For each workflow ID: poll `training.getAutoLabelWorkflow` every ~1.5s (with simple backoff to ~5s on no change). Stop when status is `succeeded`, `failed`, or `expired`. Fire `onResult` per step as it transitions to `succeeded`, and `onError` per step that transitions to `failed` — the helper keeps going for the rest of the batch instead of aborting.

**Retry on failure**: failed steps surface in the modal as a per-image error list with a "Retry failed" button. Clicking it re-runs `uploadAndSubmitAutoLabel` with only the failed images (no automatic retry — user-triggered, per the design discussion). The blob upload is a fresh call too, since the previous presigned URL may have expired.

### Updated: `src/components/Training/Form/TrainingAutoLabelModal.tsx`

Stop building a JSZip and uploading to S3. Instead, when the user clicks **Submit**:

- Resolve the source images (already in the training image store) into Blobs.
- Call `uploadAndSubmitAutoLabel(...)` with form values.
- Reuse the existing `autoLabeling` store slice (`url`, `isRunning`, `total`, `successes`, `fails`) but set the URL field to the **first workflowId** (or rename it to `workflowIds: string[]`) so multiple-batch progress can be aggregated.

### Updated: `src/components/Training/Form/TrainingCommon.ts`

- Remove the `useOrchestratorUpdateSignal` listener for tag/caption results — the new path doesn't use signals.
- Keep the **post-processing logic** (blacklist, prepend, append, threshold filter, max-tags slice, audit-prompt safety filter) and **expose it as a pure function** `applyTagPostProcess(rawTags, postProcess)` / `applyCaptionPostProcess(rawCaption, postProcess)` so both the orchestrator helper and any debugging tooling can call it.
- The helper's `onResult` callback runs the post-processor and then calls the existing `updateImage(modelId, mediaType, { matcher, label, appendLabel })` action.

### Updated: `src/components/Training/Form/TrainingImages.tsx`

Drop the auto-trigger `useEffect` (lines ~989–1004) that fires the legacy mutations when `autoLabeling.url` changes — kicking off work moves into the modal's submit handler now.

## Phase 3 — Cleanup (do last, behind a flag)

Land Phases 1+2 behind a Flipt flag `trainingAutoLabelOrchestrator` (mod-only first, then public). Keep both code paths alive until we've confirmed parity in production.

Once flipped on for everyone:

- Delete `autoTag` / `autoCaption` tRPC procedures and their service handlers in `training.service.ts`.
- Delete the legacy orchestrator types (`Orchestrator.Training.ImageAutoTagJobPayload` etc.) if unused elsewhere.
- Delete the auto-label branch of the `useOrchestratorUpdateSignal` handler in `TrainingCommon.ts`.
- Delete the `TrainingImagesTemp` S3 upload code path if it's only used for auto-label zips.

## Open questions

@ai: **Batch size of 16** — is that an orchestrator hard limit you've already validated, or a soft target we should make configurable? Worth knowing if a large set (e.g. 200 images) should fan out 13 workflows in parallel, or whether we should serialize to avoid rate limiting.

A: The orch processes a max of 64 tasks per GPU so just a number that allows a few different workflows to land nicely onto the GPU. No hard-limit really, just a suggestion. Less than 16 is also fine.

@ai: **Polling cadence** — 1.5s feels right for UX but is chatty. Acceptable, or should I bake in exponential backoff aggressively?

A: 1.5s feels fine.

@ai: **Workflow metadata size** — `postProcess` could be large if blacklist is huge. Want me to cap blacklist length, or trust the form-level limit?

A: Lets cap it sure, but usability of blacklist has shown it to never be too large, so not too concerning at the moment.

@ai: **Cost model** — the example shows `cost.total = 2`. Is the system account *actually* covering those credits, or do we still need `requireBuzz: false` / equivalent on the workflow body?

A: Correct, system covers the cost. Current captioning/tagging is free, so we'll avoid introducing costs just yet.

@ai: **Failure granularity** — if step 7 of 16 fails but the rest succeed, do we retry just that step (resubmit a single-step workflow), or surface the failure and let the user retry from the UI?

A: Having the user retry should be fine if needed.
