# Training Studio: publish a run as a new version of an existing model — scope

Status: scoped, not started. Size: **medium, about 5–7 dev-days** including tests and review.

## The ask

Publish from Training Studio always creates a new model. Creators who want the result as V2 of a
model they already have download the checkpoint and re-upload it, which drops everything the publish
path carries: the training data file, the run's training details, the dataset archive, the epoch
picker and the run ↔ model back-link. The in-app trainer had the same gap.

Done when: from a finished run, a creator can choose one of their own LoRA models, land in that
model's version wizard with the chosen epoch already attached as a new draft version, and publish it.
The new version carries the same training links a studio-born v1 does.

## Today's publish path

| Step                                                                                                                                               | Where                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Studio "Publish a model page" links to the host's `publishUrl({ workflowId, epoch })`                                                              | `apps/training-studio/src/routes/RunDetail.svelte`, `src/lib/element/backend.ts`                                     |
| SSR: owner check (the orchestrator 404s a foreign workflow), then `createDraftModelFromWorkflow` → Draft Model + `v1` + private Training Data file | `src/pages/models/train/from-orchestrator.tsx`, `src/server/services/orchestrator/training/publish-from-workflow.ts` |
| Client: move the epoch blob, create the Model file, mark the version Approved, then go to **model** wizard step 2                                  | same page, `PrepareModel`                                                                                            |
| Publish: `assertTrainingSourcePublishable` gates; `stampWorkflowPublished` back-links the run                                                      | `model.controller.ts`, `model-version.controller.ts`                                                                 |

**The blocker:** the run ↔ Civitai link is stored **once per model**, as the server-owned keys
`Model.meta.trainingStudioWorkflowId` and `trainingStudioModerationApproved`
(`SERVER_OWNED_META_KEYS`, `src/server/utils/minor-flag-meta.ts`). A model with versions from
several runs can't be described that way, and an existing model has neither key. Every reader of the
key assumes "one run per model":

| Reader                                                                                     | What breaks for an added version                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `assertTrainingSourcePublishable` (publish model, publish version ×2, private-model paths) | It reads the model's meta. A version from a run on a non-studio model is **never checked**, so the training-data approval gate would be skipped. |
| `stampWorkflowPublished`                                                                   | It is only called from model publish. Publishing a version (the normal path for V2) never marks the run `published`.                             |
| `studio-dataset-archive.service.ts`                                                        | It finds the workflow from model meta. Without it, the placeholder is never replaced by the dataset zip and ends as `unavailable`.               |
| `src/pages/api/mod/training-data/resolve.ts`                                               | The "not archived yet" guard is keyed on model meta.                                                                                             |
| `apps/moderator/.../training-moderation.service.ts` `getTrainingVersionDetail`             | `studioWorkflowId` is null unless it matches model meta, so the review page loses the studio link.                                               |
| Draft lookup in `createDraftModelFromWorkflow`                                             | Re-entry is matched by model meta, so the same run can't be resolved to a version.                                                               |

So the change is mostly the link refactor; the new UI is small.

## Plan

### 1. Version-level link (≈2 days, most of the risk)

- Write `trainingStudioWorkflowId` and `trainingStudioModerationApproved` to **`ModelVersion.meta`**
  too. No migration: the column exists, and the client meta schema (`meta` in
  `model-version.schema.ts`) is an allow-list, so clients can't write these keys. Add them to
  `ModelVersionMeta`. Also apply the server-owned treatment on any version path that replaces meta
  wholesale.
- New studio v1 drafts write both levels. Readers check the version first and fall back to the model,
  so existing drafts and published models keep working with no backfill.
- `assertTrainingSourcePublishable` takes the versions being published, not just the model's meta.
  Model-level publish checks every version it publishes.
- Call `stampWorkflowPublished` from version publish too, using the version's run.
- Point the archive job, mod resolve, and moderator detail at the version's run.

### 2. Server: `createDraftVersionFromWorkflow` (≈1 day)

Same shape as `createDraftModelFromWorkflow`, sharing its helpers (training details, hyperparameters,
`TrainingResultsV2`, placeholder file):

- **Ownership:** `model.userId === user.id`. Moderators get no bypass, because this creates content
  on the caller's own account. The model is not deleted, `type = LORA`, and `mode` is not
  archived or taken down.
- Approval gate before anything else, as today.
- Idempotent per run: match an existing version by `ModelVersion.meta.trainingStudioWorkflowId`
  (excluding owner-deleted ones), and return it.
- Create a Draft `Trained` version on the chosen model. Its name is the next `vN`, its trigger words
  come from the run, and it goes through `upsertModelVersion`, which creates it at index 0 and moves
  the other versions down.
- Stamp the version-level keys; `stampWorkflowDraftModel` back-links the run as now.

### 3. Main-app entry (≈1 day)

- `from-orchestrator` accepts `target=existing` (picker) and `modelId` (chosen).
- The picker lists the caller's eligible LoRA models with a search box. Models whose latest version
  shares the run's base model are sorted first. A mismatch is allowed with a warning, since a model
  may mix base models.
- When the model is chosen, run the same unattended `PrepareModel` step, then go to the **version**
  wizard (`/models/{id}/model-versions/{vid}/wizard?step=2`), not the model wizard.
- New refusal reasons: `model-not-eligible` and `already-published-elsewhere`.

### 4. Studio (≈0.5 day)

- The publish panel gets a second action, "Add as a new version". The studio has no database, so
  the picker lives on the main-app page, and the studio only builds the URL. Extend `PublishRequest`
  with `target`. A host that doesn't support it still shows only the existing CTA.
- The run list and detail already read `modelId`/`modelVersionId`/`published` from workflow
  metadata. Check that "Published" links the version (`?modelVersionId=`), not just the model.

### 5. Tests (≈1 day)

- `publish-from-workflow.test.ts`: the ownership refusals, idempotent re-entry, and the version keys
  being written.
- The gate: a version from an **unapproved** run on a non-studio model is refused at version publish
  and at model publish, and the same version from an approved run gets through. This is the
  regression that matters, so it runs against the **real** `assertTrainingSourcePublishable`, with
  only its orchestrator read faked. `model.publish-downed-version.test.ts` stubs the gate out, so it
  can't carry this test; use a new controller suite.
- The back-link: in the same real controller → service suite, each publish path (model publish,
  version publish) calls `stampWorkflowPublished` **exactly once**, asserted with
  `toHaveBeenCalledTimes(1)`. Step 1 adds a second call site, and a model publish that also goes
  through version publish would stamp twice.
- `from-orchestrator.page.test.ts`: the new params and refusals.
- Studio: the publish-URL builder with `target`.

## Decisions taken (change before building if wrong)

- **One live destination per run.** If the run already has a draft (new model or added version),
  publishing again resumes that draft rather than creating a second one. To move it, the creator
  deletes the draft first, which is the same rule `studioModelNotOwnerDeleted` applies today.
- **Owner only.** No adding to a collaborator's or another user's model in this pass.
- **No base-model restriction**, only a warning, which matches the version wizard.
- **The in-app trainer is deferred, not covered.** It has the same gap: `/models/train?modelId=` only
  resumes a classic-trainer draft or run on its own model. It doesn't add a version to an existing
  model. It is being replaced by the studio (`trainingStudioUi` sends new trainings there), so the fix
  lands in the studio only. Revisit only if the classic trainer stays live after the studio rollout.

## Open checks before step 3

- Confirm that the version wizard's Files step accepts a `Trained` version, and shows the epoch
  picker from `metadata.trainingResults` the same way the model wizard does.
- Find out whether the block publish path (`blocks.router.ts` → `from-orchestrator`) should offer
  this option. The default is no; blocks keep new-model-only.
