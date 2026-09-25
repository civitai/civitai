---
name: add-trainer-model
description: Add a new trainable base model to BOTH trainers end-to-end — the in-app trainer (main Next.js app, src/) and the Training Studio (apps/training-studio). Orchestrates add-ecosystem (if the base model is missing) and add-training-support (main-app wiring), then mirrors the model into the Training Studio catalog, which nothing else covers. AI-Toolkit only (Kohya is discontinued). Use when onboarding a new model family for training, or a new version of one — e.g. ZImage, MiniMax H3, a new Flux/Wan variant. Always checks whether @civitai/client ships the ecosystem's training input type first.
---

# Add a Trainer Model

There are **two** trainers, and a new trainable model has to land in both or it will only appear in one:

1. **In-app trainer** — the "Train a LoRA" flow in the main Next.js app (`src/components/Training/**`,
   `src/utils/training.ts`, `src/server/...`). Kohya + AI-Toolkit. New models are gated behind a
   per-model **Flipt flag** (mod-only until launch).
2. **Training Studio** — the SvelteKit replacement at `apps/training-studio`. **AI-Toolkit only.** Its
   model catalog is a **vendored mirror** of the in-app trainer's list, and it has its own per-model gate:
   a `ModelCard.flagKey` (Flipt, fail-closed, resolved server-side) hides a new model from everyone but
   the segmented cohort until launch — the mirror of the main app's `<name>Training` flag. A card with no
   `flagKey` is visible to every signed-in user immediately.

This skill is the umbrella that keeps the two in step. It owns the **decision layer** (the three facts
below), delegates the pieces that already have skills, and owns the Training Studio mirror step, which
no other skill covers.

> **AI-Toolkit only.** Kohya has been discontinued; every new model trains via AI-Toolkit. The one
> exception you may meet is a Flux.2-style model that has no AI-Toolkit ecosystem and trains through
> the older `imageResourceTraining` path with an explicit base AIR and its own `engine`
> (`flux2-dev`, `flux-dev-fast`, `musubi`). It takes **no** AI-Toolkit hyperparameters. Treat it as the
> rare case and confirm with the user before going down it.

## The three facts to establish first (Step 0)

Ask the user or infer from the model card / an orchestrator sample. Do **not** touch any file until all
three are answered — each one changes what you do:

1. **Does the base model / ecosystem already exist?**
   ```bash
   grep -niE "<name>" packages/civitai-shared/src/basemodel.constants.ts
   ```
   The definitions live in the `@civitai/shared` package — `src/shared/constants/basemodel.constants.ts`
   is a 4-line re-export shim (grepping it finds nothing, for every model). Look for `ECO.<Name>`, an
   `EcosystemRecord`, and a `BaseModelRecord`. **If any are missing → run the
   `add-ecosystem` skill first** (it creates the ECO/BM constants, ecosystem, family, license and base
   model). This skill assumes they exist.

2. **Is it the same ecosystem as a model that is already trainable, or a genuinely new one?**
   - **New version of an existing trainable ecosystem** (e.g. another Wan version, another SDXL
     fine-tune) → you are adding a `trainingModelInfo` **key** to an ecosystem already wired up. Most of
     the main-app plumbing (schema enum aggregate, orchestrator union branch, feature flag,
     `baseTypeToEcosystem`, `isAiToolkitSupported`) is already in place; you mainly add the new key +
     its UI defaults, and a new **version** to the existing Training Studio card.
   - **New ecosystem** → the full `add-training-support` file list applies, and the Training Studio gets
     a **new card**.
   Confirm the exact orchestrator `ecosystem` literal and whether the SDK type carries a `modelVariant`
   (Flux.1 `dev|schnell`, Wan `2.1|2.2`, Flux.2 Klein `4b|9b`) — this disambiguates "new version" from
   "new ecosystem".

3. **Does `@civitai/client` ship the ecosystem's training input type?** The orchestrator API depends on
   the SDK, so submission validation and the typed dispatch need it.
   ```bash
   grep -niE "<Name>AiToolkitTrainingInput|ecosystem: '<name>'" \
     node_modules/@civitai/client/dist/generated/types.gen.d.ts
   ```
   - **Present** → note the exact `ecosystem` literal, whether `modelVariant` is required, any fixed
     fields (e.g. Boogu `batchSize` fixed at 1), and the server-computed `readonly` outputs (never send
     those).
   - **Absent** → check `npm view @civitai/client versions --json | tail` and bump with
     `pnpm add @civitai/client@<v>`. The current pin is in `package.json` (`@civitai/client`). If the
     type is still absent after bumping, the AI-Toolkit dispatch casts `ecosystem as any` so it works
     untyped — but say so to the user and prefer a typed SDK. **The `@civitai/client` bump, when needed,
     is the answer to the brief's "does the client need updating?" — surface it explicitly.**

## Step 1 — Confirm the plan with the user

State the whole plan back before editing, across both trainers:

```
Add trainer model: <Name>
  Base model exists in basemodel.constants.ts:  yes | NO → run add-ecosystem first
  Relationship:  new ecosystem | new version of <existing ecosystem>
  @civitai/client:  ships <Name>AiToolkitTrainingInput | needs bump to <v> | untyped (cast)
  Engine:  ai-toolkit  (or imageResourceTraining/<engine> for a Flux.2-style model)
  ecosystem literal: '<eco>'   modelVariant: <none | enum>
  Media: image | video | audio
  baseType: '<baseType>'   trainingModelInfo key: '<key>'
  Defaults: steps <n>, unetLR <n>, dim/alpha <n>/<n>, scheduler <x>, batch <n> (max <n>), res <n>
  AIR: <placeholder HF urn | civitai urn>
  Main-app Flipt flag: <name>Training / <name>-training  (mod-only)
  Training Studio: new card | new version on the <family> card
    flagKey: '<name>-training' (gate a new model) | none (launch to all) — see Step 3
```

Wait for confirmation, then make each trainer's edits in one pass.

## Step 2 — In-app trainer (run `add-training-support`)

The `add-training-support` skill is the authoritative, current file-by-file recipe for the main app —
**follow it, do not re-derive it here.** In brief it edits:

- `src/utils/training.ts` — `trainingModelInfo` entry + the ~7 supporting spots (`trainingBaseModelTypes*`,
  `aiToolkitStepDefault`, `aiToolkitBatchMax`, `baseTypeToEcosystem`, `isAiToolkitSupported`,
  `isAiToolkitMandatory`, `getDefaultEngine`).
- `src/server/schema/model-version.schema.ts` — `trainingDetailsBaseModels<Name>` + spread into the
  media aggregate.
- `src/server/schema/orchestrator/training.schema.ts` — a branch in the `aiToolkitTrainingParams` union.
- `src/server/services/feature-flags.service.ts` — the `<name>Training` flag (create the Flipt flag with
  the `flipt` skill; mod-only).
- `src/components/Training/Form/TrainingParams.tsx` — per-base `overrides` (keyed by `<key>`).
- `src/components/Training/Form/TrainingSubmitModelSelect.tsx` — the `<ModelSelector>` block + the
  experimental-build alert.
- `packages/civitai-shared/src/basemodel.constants.ts` — `ecosystemSupport` training entry (`loraOnly`).
  (The main app imports this via the `src/shared/constants/basemodel.constants.ts` re-export shim; edit
  the real file in the package, not the shim.)

**Fact 2 tells you how much of this applies:** a *new version of an existing ecosystem* usually needs
only the `trainingModelInfo` key, the `TrainingParams` overrides and the schema aggregate — the union
branch, flag and `baseType*` sets already exist. A *new ecosystem* needs the whole list.

**For a Flux.2-style `imageResourceTraining` model**, `add-training-support`'s AI-Toolkit union branch
does not apply; instead the `trainingModelInfo` entry carries an `engine` (e.g. `flux2-dev`) and an
explicit base `air`, and `training.orch.ts` already routes known engines. Grep `flux2_dev` in
`src/utils/training.ts` for the parallel to copy.

## Step 3 — Training Studio catalog mirror

The catalog is `apps/training-studio/src/lib/data/trainingModels.ts` — a hand-mirrored snapshot of
`trainingModelInfo`, grouped into one **card per family** whose flat entries become that card's
**versions**. Nothing imports it from the main app (an `apps/*` package cannot reach the main app's
`src/`), so this step is manual and is the half of the task no other skill does.

> 🔴 **Gate a new/experimental model behind a feature flag here too — same policy as the main app.** The
> in-app trainer mod-gates a new model behind its `<name>Training` Flipt flag; the Training Studio has the
> matching mechanism: set **`flagKey`** on the card (Step 1 below). A card with a `flagKey` is offered only
> to users the server evaluated that flag `true` for — and it is **fail-closed**: until the flag is created
> and segmented in the `civitai-app` Flipt environment, only moderators see it, so the model ships dark. An
> ungated card (no `flagKey`) is shown to everyone; that is the right choice only for a model launching to
> all users at once. **When in doubt, gate it** — an unflagged new model is live for everyone the moment
> the catalog deploys.

Edit `trainingModels.ts`:

1. **`MODEL_CARDS`** —
   - *New version of an existing family* → add a `ModelVersionInfo` to that card's `versions` array
     (newest first — `versions[0]` is the default selection). Copy `key`, `air`, `baseModel`,
     `ecosystem`, and `modelVariant` **verbatim** from the `trainingModelInfo` entry you just wrote in
     Step 2; a drift here produces a wrong AIR at training completion.
   - *New family* → add a new `ModelCard`: `type` (the `baseType`, or a synthetic family id where the
     source splits a family across several `type`s), `name`, `code` (2-letter), `media`, `label`
     (`'tag'` for booru-tag families — SD1.5/SDXL/Pony/Illustrious — else `'caption'`; set
     `bothLabels: true` only if it trains on either), `description`, optional `flag` badge, `released`
     (`YYYY-MM-DD`, hand-researched), and `versions`.
   - **`flagKey`** → set it (to the Flipt gate key, e.g. `'<name>-training'`, reusing the main-app
     training flag or a Studio-specific one) for any new/experimental model so it stays mod-only until
     launch. Omit it only for a model going live to everyone. Create the flag with the `flipt` skill in
     the `civitai-app` environment; gating is fail-closed until it exists. The gate applies to the whole
     **card** (family) — for a *new version of an already-launched family*, gate at the card level only if
     the whole family should re-close, which is unusual; a single gated version within a shown card is not
     supported (note it in `REVIEW.md` if you hit that case).
   - Set `isNew: true` on the version while it is new.

2. **`PARAM_DEFAULTS`** — add an entry **keyed by the version `key`** with the AI-Toolkit-resolved
   advanced defaults (`epochs`, `unetLr`, `textEncoderLr` — `0` means text-encoder training off,
   `networkDim`, `networkAlpha`, `resolution`, `batchSize` clamped to the ecosystem's max, `lrScheduler`
   normalized off `cosine_with_restarts` → `cosine`, `optimizer`). These mirror the `trainingSettings`
   `overrides` you set in `TrainingParams.tsx`, resolved for `ai-toolkit`. **A Flux.2-style
   `imageResourceTraining` model takes no hyperparameters — omit its key deliberately** (the Review step
   hides the panel when the key is absent); leave the existing `flux2_dev` comment as the precedent.

3. **`LORA_TYPES[].recommended`** — only if this model should be the auto-recommended default for a
   `{ media, loraType }` pair. Otherwise leave it; recency alone does not make it recommended.

4. **`FEATURED` in `apps/training-studio/src/routes/SelectStep.svelte`** — the short featured list per
   media (`image`/`video`). Add the card `type` here if it should appear above the "show more" fold;
   otherwise it lives in the long tail automatically.

5. **Update the mirror-date comment** at the top of `trainingModels.ts` (and the `PARAM_DEFAULTS`
   comment if numbers changed) so the next re-mirror knows the snapshot moved.

## Step 4 — Typecheck both trainers

```bash
pnpm run typecheck                                            # main app (TS 5.9, authoritative)
pnpm --filter @civitai/training-studio-app run typecheck      # Training Studio (svelte-check; NEVER `check`)
```

`typecheck` (svelte-check alone) is the right one for the Training Studio — never `check`, which runs
`svelte-kit sync` and fights the dev server's watcher (see `apps/training-studio/CLAUDE.md`). Since this
change touches only a data module and not the route tree, `sync` is not needed. Read `svelte-check`'s
**WARNING** lines too, not just errors. Common failures: a `baseType`/`key` typo that misses the
`TrainingBaseModelType` union, a missing spread in a schema aggregate, a `baseModel` string that is not a
valid `BaseModel`, or a `PARAM_DEFAULTS` key that does not match its `ModelVersionInfo.key`. Iterate until
both are clean.

## Step 5 — Verify (optional)

- **In-app trainer**: with a dev server (`dev-server` skill) and the `<name>Training` Flipt flag on for
  your user, open the training form → Step 1 shows the new base model under its media; selecting it
  loads the expected defaults; a `whatif` submit returns a price with no validation error.
- **Training Studio**: `pnpm dev:training-studio` (`TRAINING_STUDIO_DEV_LOGIN=1` in its `.env` to skip
  OAuth) → the Select step shows the new card/version, auto-picks the right labeler (tags vs captions),
  and the Review step's whatif price resolves. The dev-login stub sees the whole catalog including gated
  cards; to check the **gate** itself, evaluate the flag against a real signed-in non-mod user (or toggle
  it in Flipt) and confirm a gated card is hidden until the flag is on.

## Recap of what lives where

| Concern | In-app trainer | Training Studio |
|---|---|---|
| Model catalog | `src/utils/training.ts` `trainingModelInfo` | `trainingModels.ts` `MODEL_CARDS` (mirror) |
| Advanced param defaults | `TrainingParams.tsx` `trainingSettings` | `trainingModels.ts` `PARAM_DEFAULTS` |
| Submission validation | `training.schema.ts` union | (server uses main-app orchestrator schema) |
| Feature flag gate | `<name>Training` (Flipt, mod-only) | `ModelCard.flagKey` (Flipt, fail-closed; omit to launch to all) |
| Engine | ai-toolkit / imageResourceTraining | ai-toolkit only |

## Notes

- **Base-model key vs baseType**: they can differ (SD's `sd_1_5`/`anime`/… keys all map to baseType
  `sd15`); for a single-checkpoint ecosystem keep them the same. The Training Studio `PARAM_DEFAULTS`
  and `MODEL_CARDS.versions[].key` use the **key**; `LORA_TYPES.recommended` and `FEATURED` use the
  card **`type`**.
- **Placeholder AIR**: fine to ship before the base model is on civitai — for AI-Toolkit-only ecosystems
  it is not sent to the orchestrator (resolved from the ecosystem). Leave a comment in both files to swap
  in `urn:air:<eco>:checkpoint:civitai:<modelId>@<versionId>` once uploaded, and keep the two AIRs
  identical.
- **Keep the two catalogs identical for the fields that matter**: `key`, `air`, `baseModel`, `ecosystem`,
  `modelVariant`. The Training Studio's `findByAir` maps a completed workflow's AIR back to a card, so a
  divergent AIR silently loses that mapping.
- This skill pairs with `add-ecosystem` (base model), `add-training-support` (main-app half), `flipt`
  (the flag), and — for the generation side, which is independent — `add-generation-support`.
