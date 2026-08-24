# Training filenames / epoch numbering — review follow-ups

Findings from reviewing branch `feature/training-filenames` — commit `80f6974b79` plus the
uncommitted Review-step work. Merged as PR #4329.

Perf came back clean and is not listed: the two widened `trainingDetails` selects measured the same
4 buffers, the training webhook path gained zero I/O, and the new client modules added no bundle
weight (`~/utils/training` was already a value import in that chunk via `training.store.ts`).

**Status:** everything answerable from the repo is done. What remains needs a decision from a
person — the three under Open questions, plus the dead-v1-auto-label call at the bottom.

## Defects

- [x] **The what-if error log records the masked message, not the real one.**
      `createTrainingWhatIfWorkflow` logged `e.message` where `submitWorkflow` throws
      `throwServiceUnavailableError(ORCHESTRATOR_UNAVAILABLE_MESSAGE, error)` — a generic constant
      with the orchestrator's actual error on `.cause`. Now built by `buildCentralErrorLog(e)`,
      which un-masks the cause and picks the same client/server severity the ternary did.
- [x] **The same log omits `markServerFaultLogged(e)` before rethrowing.** Added, guarded on
      `classifyErrorFault(e) === 'server'` so a client-fault 4xx is not marked.
- [x] **`cost === 0` takes neither branch.** Resolved as *reword*, not widen: `TrainingSubmit`
      gates on the identical `!isDefined(cost) || cost < 0` and spends a zero without complaint, so
      0 is a valid price and the guard was right. The message is now "Orchestrator returned an
      unusable cost", and the comment records why 0 sits deliberately outside it.
- [x] **`epochOffset`'s comment asserts an invariant nothing enforces.** Corrected rather than
      enforced: `modelFileMetadataSchema` accepts `trainingResults` from the client on
      `modelFile.create`/`upsert`, so an owner can seed any offset onto their own run. The comment
      now says so. Impact is cosmetic — shifted epoch numbers on your own model.

## Test gaps — each was confirmed by a mutation no test caught, and each mutation is now red

- [x] **Archive architecture segment.** `getTrainingEpochArchive`'s fixture gained
      `trainingDetails: { baseModel: 'pony' }` and asserts `_pony_` in `archiveName` and two
      entries. Setting `architecture: null` now fails 1 test.
- [x] **Download handler filename.** New `src/server/__tests__/training-epoch-download-filename.test.ts`
      — outside `src/pages`, which Next treats entirely as routes. Asserts the `Content-Disposition`
      filename for two architectures and for a run predating the field, plus the untrusted-host
      refusal. Reverting to the old `model.name.replace(...)` one-liner fails 3.
- [x] **The what-if logging has no test at all.** New
      `src/server/services/orchestrator/training/__tests__/training-whatif-logging.test.ts` — 5 tests
      over severity, the un-masked cause, `userId`, the fault mark, and the three cost branches.
- [x] **Epoch `0` boundary.** `ingest([0, 1])` against an offset of 10 expects `[10, 11]`; mutating
      `>= 0` to `> 0` swallows epoch 0 into the -1 sentinel and fails.
- [x] **The `Math.max(0, …)` clamp in `epochsCompletedForRun`.** A continuation whose only ingested
      epoch is the sentinel (`highest` 0, offset 10) now has a case; dropping the clamp renders
      -10/10 and fails.

## Fragile wiring

- [x] **`TrainingSelectFile` hand-built `{ epochs, epochOffset }`.** Now passes `trainingResults`
      wholesale, the way `UserTrainingModels` does.

## Consistency

- [x] **`maxTrainEpochs` renders as "Checkpoints"** for AI-Toolkit runs in
      `TrainingSubmitAdvancedSettings`. The summary card now matches, and the schema settles which
      side was wrong: `aiToolkitTrainingDetailsParams.epochs` is documented as the saved-checkpoint
      count, so labelling it "Epochs" was the mislabel. Kohya's `maxTrainEpochs` stays "Epochs".
- [x] **Row labels are re-hardcoded.** Aligned to the `trainingSettings` strings — "Train Batch
      Size", "Unet LR", "Text Encoder LR", "LR Scheduler", and "Network Dim"/"Network Alpha" split
      into their own rows. Still duplicated rather than imported: `trainingSettings` lives in a
      `.tsx` component module and `run-summary` runs inside the epoch-download API route, so
      importing it would drag React into that graph.
- [x] **The base-model pretty-name lookup exists in eight places with five different fallbacks.**
      `prettyTrainingBaseModel()` now lives beside `trainingModelInfo` and the review card uses it,
      so a custom base model reads "Custom" on both screens instead of "Custom" on one and "sdxl"
      on the other. **The other seven call sites are unconverted** — they are in the submit flow, and
      converting them changes user-visible copy, which is a wider change than this follow-up needs.
- [x] **The continuation badge drops `sourceVersionName`.** It now reads "Continued from epoch #12
      of MyLoRA v2", matching the existing render, and falls back to the bare epoch when the run
      recorded no name.

## Answered from the repo — no longer open

- [x] **"The settings used" is 10 of ~24 fields; LoRA Type is the notable omission.** LoRA Type
      cannot discriminate anything: `loraTypes` in `src/utils/training.ts` has exactly one member,
      `'lora'`. What the requester is telling apart — "same dataset, multiple formats" — is the base
      model, and that is the badge. Nothing is hidden by leaving it out.
- [x] **Does "model save names" mean the epoch download or the published file?** The epoch download.
      The published `ModelFile` is named from the blob id (`moveAssetFromBlob` →
      `<blobId>.safetensors`), which is globally unique and opaque — it can be *unhelpful*, but never
      *identical*, and the report was specifically that multi-architecture training "produces
      identical filenames". Only `<model>_epoch_N` had that property. Giving the published file a
      meaningful name is separate and already shipped — `overrideName` (`e5573c88f6`, #2737) is
      editable on the model-wizard version step and in the file list, and `getDownloadFilename()`
      prefers it. It carries no architecture segment; that is the only remaining gap on that path.
      Record: [docs/features/training-file-rename.md](features/training-file-rename.md).

## Open questions — need a person, not the repo

- [ ] **The version scope serves neither ticket.** Cumulative numbering alone removes the
      continuation collision; the architecture segment alone separates a multi-training batch. The
      `v1-1284593` component addresses a third, unreported collision — two same-architecture runs on
      one model — and costs the requested shape: the ask was `esadribicstyle_krea2`, what ships is
      `esadribicstyle_krea2_v1-1284593_epoch_10.safetensors`. Decide whether to keep it, keep only
      the id, or drop it.
- [ ] **The Mage-Flow ticket's symptom is unchanged.** The diagnostics are the correct app-side
      response to an orchestrator-side cause, but nothing user-visible moved, and there is no record
      in this repo that the orchestrator-side work was filed. The ticket now reads as addressed.
- [ ] **`/api/v1/model-versions/mini/[id]` — not live, but two bugs that must be fixed together.**
      The endpoint answers an `epoch` miss with the *newest* epoch rather than a 404 — it returns
      that epoch's download url and AIR with no indication it substituted. (It does not echo an
      epoch number back; the sibling `getTrainingFileEpochNumberDetails` does, via
      `epochNumber: epochNumber ?? …`, and its one caller is generation binding in
      `generation.service.ts:1221` — same fallback, mislabelled result.) Renumbered continuations
      would walk straight into both.
      It is unreachable today only by accident: the handler does `schema.safeParse(req.query)`, and
      `epoch` is a bare `z.number()` where `id` and `modelFileId` are both `z.coerce.number()` — so
      `?epoch=3` is a 400 and the param cannot be supplied over HTTP at all. Verified against the
      real schema, not read off the source.
      **The hazard is the obvious tidy-up**: adding `.coerce` to match its neighbours silently turns
      the fallback on for a public, `MixedAuthEndpoint` route. Decide whether the param should work,
      and if so replace the last-epoch fallback with a 404 in the same change.

## Map contribution — not this branch's work

- [ ] `training.service.ts` has two live auto-label paths: v1 (`autoTagHandler`/`autoCaptionHandler`)
      and v2 (`submitAutoLabelWorkflow`), both wired as tRPC procedures. Only v2 handles audio, and
      the only client caller uses v2 — so v1 may be dead rather than duplicated, and that is a
      deletion someone should confirm. Their failure handling differs; resolve that first (tracked
      privately).
