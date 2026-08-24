# Training filenames / epoch numbering — review follow-ups

Findings from reviewing branch `feature/training-filenames` — commit `80f6974b79` plus the
uncommitted Review-step work.

Perf came back clean and is not listed: the two widened `trainingDetails` selects measured the same
4 buffers, the training webhook path gained zero I/O, and the new client modules added no bundle
weight (`~/utils/training` was already a value import in that chunk via `training.store.ts`).

## Defects

- [ ] **The what-if error log records the masked message, not the real one.**
      `createTrainingWhatIfWorkflow` logs `e.message`. `submitWorkflow` throws
      `throwServiceUnavailableError(ORCHESTRATOR_UNAVAILABLE_MESSAGE, error)` — a generic constant,
      with the orchestrator's actual error preserved on `.cause`. `buildServerFaultErrorLog(e)` in
      `src/server/logging/client.ts` exists to un-mask exactly this. As written the logging added to
      diagnose Mage-Flow cost failures captures nothing about the failure.
- [ ] **The same log omits `markServerFaultLogged(e)` before rethrowing**, so a server fault is
      logged a second time by the central chokepoint — in a different dataset, so the two do not
      dedupe by eye. `buildCentralErrorLog(e)` returns the whole shape in one call.
- [ ] **`cost === 0` takes neither branch.** The guard is `cost == null || cost < 0` while the log
      message reads "Orchestrator returned no cost" and the comment says "priced it at nothing".
      Decide: widen to `<= 0`, or reword both.
- [ ] **`epochOffset`'s comment asserts an invariant nothing enforces.** The comment on
      `trainingResultsV2Schema` and `updateTrainingWorkflowRecords` both describe it as
      server-stamped; the type says only `int().nonnegative().optional()`. Correct the comment, or
      enforce it.

## Test gaps — each confirmed by a mutation that no test catches

- [ ] **Archive architecture segment.** Setting `architecture: null` in `getTrainingEpochArchive`
      passes 8/8. The `getTrainingEpochArchive` fixture has no `trainingDetails`, so the segment
      never appears in an asserted filename. The realistic regression is someone trimming the Prisma
      select this branch widened. Fix: add `trainingDetails` to the fixture and assert `_pony_` in
      `archiveName` and one entry.
- [ ] **Download handler filename.** Reverting it to the old
      `modelVersion.model.name.replace(...)` one-liner turns nothing red — and that revert
      reintroduces the collision the feature exists to fix. Handler test belongs in
      `src/server/__tests__/`, never under `src/pages` (Next treats every file there as a route).
- [ ] **The what-if logging has no test at all.** Flipping the
      `classifyErrorFault(e) === 'client' ? 'info' : 'error'` ternary is invisible, as is dropping
      `userId`. It is the only new code on a pricing-adjacent path.
- [ ] **Epoch `0` boundary.** Mutating `e.epochNumber >= 0` to `> 0` passes; the ingest tests only
      ever use `[1,2,3]` and `[-1]`, so neither side of the sentinel boundary has a case.
- [ ] **The `Math.max(0, …)` clamp in `epochsCompletedForRun` is untested.** It fires when
      `epochOffset` exceeds the highest stored number — a continuation whose only ingested epoch is
      the `-1` sentinel reaches it (`highest` 0, offset 10). Add that case; do not drop the clamp.

## Fragile wiring

- [ ] **`TrainingSelectFile` hand-builds `{ epochs, epochOffset }`** where `UserTrainingModels` passes
      `trainingResults` wholesale. Drop that one property and continuations display `15/10` again
      with every test green. Pass the object wholesale.

## Consistency — the same value named or derived differently across screens

- [ ] **`maxTrainEpochs` renders as "Checkpoints"** for AI-Toolkit runs in
      `TrainingSubmitAdvancedSettings` — deliberately, because it is not epochs there. The new
      summary card calls it "Epochs". Set it on one screen, read it back under another name.
- [ ] **Row labels are re-hardcoded** rather than read from `trainingSettings`, which already owns
      them: "Batch size" vs "Train Batch Size", "Learning rate" vs "Unet LR", "Scheduler" vs
      "LR Scheduler".
- [ ] **The base-model pretty-name lookup now exists in eight places with five different fallbacks** —
      `'Custom'`, `'Unknown'`, `'this model'`, the raw key, and the family key. For a custom base model the training list says
      "Custom" and the review card says "sdxl". Extract one `prettyTrainingBaseModel(baseModel)`
      beside `trainingModelInfo`.
- [ ] **The continuation badge drops `sourceVersionName`.** The existing render says
      "Epoch #12 of MyLoRA v2"; the new badge omits which run it continued from, though the field is
      on the same object.

## Intent — decisions, not defects

- [ ] **The version scope serves neither ticket.** Cumulative numbering alone removes the
      continuation collision; the architecture segment alone separates a multi-training batch. The
      `V2-1284593` component addresses a third, unreported collision (two same-architecture runs on
      one model) and costs the requested shape — the ask was `esadribicstyle_krea2`. Decide whether
      to keep it, keep only the id, or drop it.
- [ ] **"The settings used" is 10 of ~24 fields.** LoRA Type is the notable omission: the request is
      about telling *formats* apart, and format is not shown in the badge or the rows.
- [ ] **Does "model save names" mean the epoch download or the published file?** The published
      `ModelFile` name still derives from the S3 asset path and carries no architecture. If the
      request meant that artifact, this work targets the wrong one. One question to the requester
      settles it.
- [ ] **The Mage-Flow ticket's symptom is unchanged.** The diagnostics are the correct app-side
      response to an orchestrator-side cause, but nothing user-visible moved, and there is no record
      in this repo that the orchestrator-side work was filed. The ticket now reads as addressed.

## Compatibility note

- [ ] `/api/v1/model-versions/mini/[id]` matches its `epoch` query param against stored numbers, and
      answers a miss with the *newest* epoch rather than a 404. New continuations are numbered from
      the offset, so an external caller still asking for `epoch=3` now silently receives epoch 13's
      url and AIR. Existing data is unaffected. Confirm this is intended for a public endpoint.

## Map contribution — not this branch's work

- [ ] `training.service.ts` has two live auto-label paths: v1 (`autoTagHandler`/`autoCaptionHandler`)
      and v2 (`submitAutoLabelWorkflow`), both wired as tRPC procedures. Only v2 handles audio, and
      the only client caller uses v2 — so v1 may be dead rather than duplicated, and that is a
      deletion someone should confirm. Their failure handling differs; resolve that first (tracked
      privately).
