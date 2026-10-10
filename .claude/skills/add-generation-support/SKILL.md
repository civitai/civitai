---
name: add-generation-support
description: Wire an existing ecosystem into the generation system. Adds generation support to basemodel.constants.ts, creates graph and handler files, and wires them into the ecosystem discriminator, workflow config, and router. Use after add-ecosystem when you need the ecosystem to show up in the generation form. Always checks @civitai/orchestration-client for ecosystem-specific types before writing the handler.
---

# Add Generation Support

Wires an existing ecosystem (already defined in [basemodel.constants.ts](src/shared/constants/basemodel.constants.ts)) into the generation form. Requires the ecosystem, base model, license, and family to already exist — use the **add-ecosystem** skill first if any of those are missing.

## When to use

- After `add-ecosystem` for a new provider
- To re-enable generation for an ecosystem that was previously commented out
- When adding a new graph/handler pair for an existing ecosystem that didn't have one

## Prerequisites check

Before starting, confirm the ecosystem exists in [basemodel.constants.ts](src/shared/constants/basemodel.constants.ts):

- `ECO.<Name>` is defined
- An `EcosystemRecord` exists in `ecosystems`
- A `BaseModelRecord` exists in `baseModelRecords`

If any are missing, stop and direct the user to run `add-ecosystem` first.

## Workflow (interactive after research)

### 1. Check @civitai/orchestration-client for ecosystem-specific types

The orchestrator client package is **`@civitai/orchestration-client`**. It is the continuation of the old
`@civitai/client`, which can no longer be published to and is frozen at `0.2.0-beta.98`; the version line
carries on unbroken in the new package (`0.2.0-beta.101` and up). **The repo depends on both** — the new
package for anything recent, the frozen one for the handlers and workflow types that still import it. New
ecosystem types only ever land in the new package.

**Always** check the latest published client version, even if types aren't in the currently installed version.

```bash
# Check installed version (either package may be present)
grep -E '@civitai/(orchestration-)?client' package.json

# Check latest available — the 'latest' dist-tag lags 'beta', so read the version list
npm view @civitai/orchestration-client versions --json | tail -20
```

Search the **latest** version's types for the ecosystem:

```bash
cd /tmp && npm pack @civitai/orchestration-client@<latest-version> 2>/dev/null
tar -xzf civitai-orchestration-client-<latest-version>.tgz
grep -n "<EcosystemName>\|<ecosystem-name>" /tmp/package/dist/generated/types.gen.d.ts
```

Note what you find (or don't find):

- **Ecosystem-specific types** (e.g., `SeedanceVideoGenInput`, `ComfyErnieStandardCreateImageGenInput`): use them — they give you the exact field shape and strict enum literals
- **Multiple variant types** (e.g., standard vs turbo): the handler will branch on model version and return the appropriate typed input
- **No types at all**: fall back to the generic `ImageGenStepTemplate` / `VideoGenStepTemplate` with a string `engine` field

If the installed version is older than the latest and the latest has useful types, bump:

```bash
pnpm add @civitai/orchestration-client@<latest-version>
```

Import new types from `@civitai/orchestration-client` rather than hand-rolling them. Handlers already
importing from `@civitai/client` keep working — leave them unless migrating them is the task you were
asked to do.

### 2. Research model defaults

If the user hasn't already pointed you at docs, check the HuggingFace or official model card for:

- **Model version IDs** on Civitai (the user usually has these — ask if not)
- **Recommended aspect ratios / resolutions** (exact dimensions)
- **Recommended guidance scale / cfg scale**
- **Recommended inference steps**
- **Supports LoRAs?** (drives resources node)
- **Supports negative prompts?**
- **Fixed sampler/scheduler** (if the provider locks these, hardcode in the handler rather than exposing UI controls)
- **Media type**: image-only, video-only, or mixed

### 3. Decide on graph structure

Based on research, pick the right shape:

- **Single model, simple**: one `sliderDef` per parameter, one aspect ratio set. Seedance is a good reference.
- **Multiple versions with same controls but different defaults**: use `createCheckpointGraph` with `versions.options`. Parameter defaults can vary via `ctx.model?.id` checks. Seedream is a reference.
- **Multiple versions with different capability sets**: use a computed `<name>Variant` discriminator and branch into separate subgraphs. Ernie is a reference — base has LoRAs, turbo doesn't.
- **Model-dependent defaults on the same node key**: if both variants have `cfgScale` but different defaults, just declare each branch arm with its own `sliderDef` defaults. **Do NOT add a `.effect()` that calls `set('cfgScale', ...)` on variant change** — see "Don't use `.effect()` to reset slider values across variants" below.

### 4. Confirm the plan with the user

Summarize:

```
Adding generation support for: <EcosystemName>

Graph: src/shared/form-graph/generation/<image|video|audio|model3d>/<name>.graph.ts
- Versions: <list with IDs>
- Aspect ratios: <list>
- Sliders: cfgScale (<range>, default <n>), steps (<range>, default <n>)
- Features: [resources, negativePrompt, images for I2V, etc.]
- Structure: [single graph | discriminator with subgraphs | version-dependent defaults]

Handler: src/server/services/orchestrator/form-graph/<name>.handler.ts
- Types: <from @civitai/orchestration-client, or generic>
- Step type: <imageGen | videoGen>
- Fixed params: sampler=<x>, scheduler=<y> (if applicable)

Wiring:
- basemodel.constants.ts: uncomment/add ecosystem support + settings
- shared/generation/config/workflows.ts: add to <TXT2IMG_IDS | TXT2VID_IDS | etc.>
- <modality>/hub.graph.ts: add the branch arm
- form-graph/index.ts: import, re-export, createStep case
```

Wait for confirmation.

### 5. Make the changes

All files listed below are required edits. Make them in one pass.

#### 5a. `src/shared/constants/basemodel.constants.ts`

Two sections:

1. **`ecosystemSupport`** — add or uncomment the support entry. Use the right model types helper:
   - `checkpointOnly` — most closed-source providers (Seedance, Seedream, Kling, etc.)
   - `checkpointAndLora` — open models that allow community LoRAs (Flux, Wan, etc.)
   - `fullAddonTypes` — SD family, Chroma (LoRA, DoRA, LoCon, TextualInversion)
   - `loraOnly` — LoRA-only ecosystems
   - `[ModelType.Checkpoint]` — explicitly checkpoint only (same as `checkpointOnly`)

2. **`ecosystemSettings`** — add the default model config:
   ```ts
   {
     ecosystemId: ECO.<Name>,
     defaults: {
       model: { id: <default version ID> },
       modelLocked: true,  // usually true for closed providers
       engine: '<engine-string>', // optional — only if getBaseModelEngine needs it
     },
   },
   ```

3. **`crossEcosystemRules`** (only if the ecosystem is cross-compatible with another) — add explicit rules for every directional pair that should allow cross-ecosystem LoRAs (or other addon types). See the "Cross-ecosystem compatibility" section below before writing any.

#### 5b. `src/shared/generation/config/workflows.ts`

- Add `ECO.<Name>` to the appropriate workflow array (`TXT2IMG_IDS`, `TXT2VID_IDS`, `EDIT_IMG_IDS`, `I2V_ONLY_IDS`, etc.)

#### 5c. Create the graph file

`src/shared/form-graph/generation/<image|video|audio|model3d>/<name>.graph.ts`. Build it with
`defineGraph<FamilyExt>({ scope: familyScope })`. Field helpers come from `../shared`
(`familyResources`, `perModelSlider`, `promptOnlyTextBlock`) and `../defs`. Ideogram 4
(`e680364460`) is a compact reference for the whole set.

Exports: always export `<name>VersionIds` (as a `const` object) so the handler can import it for
version-to-model-string mapping.

#### 5d. Register the graph

Add it to that modality's `hub.graph.ts` as a `branch` arm — `[['<Name>'], <name>]` — placed with
its family grouping.

#### 5e. Create the handler file

`src/server/services/orchestrator/form-graph/<name>.handler.ts`:

```ts
import type { <StepTemplateType> } from '@civitai/client';          // ImageGenStepTemplate | VideoGenStepTemplate
import type { <EcosystemSpecificInputType> } from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { <name>VersionIds } from '~/shared/form-graph/generation/<modality>/<name>.graph';
import { defineHandler } from '../handlers/handler-factory';
import { resourcesToLoras, type EcosystemData } from './types';

export const create<Name>Input = defineHandler<EcosystemData<'<Name>'>, [<StepTemplateType>]>(
  (data, ctx) => {
    if (!data.aspectRatio) throw new Error('Aspect ratio is required');

    return [
      {
        $type: '<imageGen | videoGen>',
        input: removeEmpty({
          engine: '<engine>',
          prompt: data.prompt,
          seed: data.seed,
        }) as <EcosystemSpecificInputType>,
      },
    ];
  }
);
```

Key points:
- Use `removeEmpty` to strip undefined values
- Cast the input to the ecosystem-specific type so TypeScript validates field names and enum values
- For resources, use `ctx.airs.getOrThrow(resource.id)` to get the AIR string, or `resourcesToLoras`
  for the common LoRA shape

#### 5f. `src/server/services/orchestrator/form-graph/index.ts`

Add the import, the re-export, and the `createStep` case:

```ts
case '<Name>':
  return create<Name>Input(data, handlerCtx);
```

### 6. Typecheck

```bash
pnpm run typecheck
pnpm exec vitest run --project 'unit*' src/server/services/orchestrator/__tests__/form-graph-step-input.test.ts src/server/services/orchestrator/form-graph/__tests__/data-discrimination.test.ts
```

If there are errors, iterate until clean. Common failures:

- **Ecosystem-specific type not found in @civitai/orchestration-client**: fall back to generic `ImageGenStepTemplate`/`VideoGenStepTemplate` with `as <Type>` casts.
- **Discriminator value not in union**: verify the key in the modality's `hub.graph.ts` `branch` arm matches the case in `form-graph/index.ts` exactly (case-sensitive).
- **Graph context missing a key**: the hub's shared fields (`prompt`, `enhancedCompatibility`) expect certain keys — don't redefine them in your ecosystem subgraph.

### 7. Verify in the form (optional but recommended)

If a dev server is running (check via the `dev-server` skill), ask the user to:
- Select the new ecosystem in the form
- Verify controls render correctly
- Verify the whatIf query returns without errors

## Post-onboarding: generation coverage & auction featurability (manual DB steps)

Three DB tables are keyed off the constants **by string or version id** but are **not derived from them** — nothing reconciles them, so they must be hand-seeded. Miss one and the feature silently half-works (the generation form still lights up from the constants, so it *looks* done). This bit us with Anima and Krea 2. None of these tables are written by app code today; each needs a raw SQL INSERT run against each environment (preview → prod) per our manual-migration rule.

See [docs/features/featured-auction-ecosystem-sync.md](docs/features/featured-auction-ecosystem-sync.md) for the full rationale and architecture; the essentials:

### 0. First: which branch of `GenerationCoverage` covers this version — and under which rule?

**`GenerationCoverage` is the one view the app reads**, and it carries both rules as columns: `covered` (live) and `coveredNext` (staged — community checkpoints qualify on their own and are downloaded on demand). The Flipt boolean `generation-coverage-next` picks the column per request, globally, default **off**. `GenerationCoverageNext` still exists in the database but no app code reads it and it is dropped after this deploys — querying it tells you nothing about what the site will do. **Read the live definition before writing any SQL** — `SELECT pg_get_viewdef('"GenerationCoverage"'::regclass, true)` — because which branch applies decides which table you need, and picking the wrong one produces SQL that runs cleanly and changes nothing.

**A top-level `m.mode IS NULL` sits above every branch of BOTH rules** (new as of `20260923140000` for the live rule): a model a moderator has archived or taken down is covered by none of them.

| Branch | Condition | Typical ecosystem |
| --- | --- | --- |
| 1 | `mv.id IN "EcosystemCheckpoints"` — **no status check, no `NOT m.poi` guard** | file-less API checkpoints, `usageControl = 'Generation'` |
| 2 | `usageControl = 'ExternalGeneration' AND status = 'Published' AND NOT m.poi` | file-less API checkpoints, mod-published |
| 3 | files + `allowCommercialUse` + `baseModel IN "GenerationBaseModel"` (or `type = 'Upscaler'`); a **Checkpoint** qualifies differently per rule — see below | downloadable weights |

Branch 3 is where the two rules part. Under `coveredNext` a checkpoint needs a scanned **SafeTensor** weight file, because the loader serves nothing else; under `covered` it needs a `CoveredCheckpoint` row instead. The file-format test differs too: `covered` excludes Diffusers for every type, `coveredNext` accepts it for everything but checkpoints. Branches 1 and 2 are identical under both.

⚠️ **The view does not know about `modelLocked`, and a covered checkpoint there is still not generatable.** `isGenerationEligible` holds a Checkpoint on a `modelLocked` ecosystem to the LIVE column whichever rule is live, because `createCheckpointGraph` rewrites any foreign checkpoint id back to the workflow default — server parse included — so it could never reach the orchestrator. Branch 2 — an `EcosystemCheckpoints` row — is on the live column, so an ecosystem's own default checkpoints are unaffected however locked it is, as is an auction winner (branch 3 under the live rule). Do not add a coverage row expecting it to make a community checkpoint generatable on such an ecosystem.

`GenerationBaseModel` is consulted by **branch 3 only**. For a file-less API model the row is inert — correct to add for the future, but it is not what makes the model generatable, so don't stop there and assume you're done.

`CoveredCheckpoint` is read by the **live** rule only (`covered`): a checkpoint that fails the SafeTensor test is still covered if the weekly auction put it on the list. The **staged** rule (`coveredNext`) ignores the table entirely. So while `generation-coverage-next` is off, a row there can make a checkpoint generatable — and the moment the flag flips, it stops. Never add one to grant coverage: it is the auction's to write, and it buys nothing under the rule we are moving to. `/api/v1/model-versions/mini/[id]` also reads the table for `isPromoted`, which is not a coverage read.

### 1a. `EcosystemCheckpoints` — covers a specific VERSION unconditionally

Keyed by `ModelVersion.id`, not by base model or ecosystem. Needed when the version has no files and is `usageControl = 'Generation'` (branch 2 won't fire). `name` is a free-text label with no behaviour attached — match the base model display name.

```sql
INSERT INTO "EcosystemCheckpoints" (id, name) VALUES (3207633, 'Qwen 3') ON CONFLICT (id) DO NOTHING;
```

**This is an unconditional override.** Branch 1 has neither a status check nor a PoI guard, so the version stays covered even if it's later unpublished or the model is flagged. That cuts both ways: it's the only way to exercise generation against a **Draft** version pre-publish, and it's a footgun if you expected coverage to track publish state. When the version is `ExternalGeneration`, prefer letting branch 2 handle it — publishing is then the only step, and unpublishing correctly revokes coverage.

Note that sibling versions on one model page routinely land on **different branches** (e.g. Qwen Image 2.0 via branch 1, 3.0 via branch 2; Seedance 2.0 via branch 1, 2.0 Mini via branch 2). That's expected, not drift.

### 1b. `GenerationBaseModel` — makes downloadable resources GENERATABLE

One of branch 3's inputs is a plain list of base-model strings in `GenerationBaseModel`. A new base model that isn't in this list is **not generatable** even with full form support (this is what silently broke Krea 2).

- **`baseModel` must equal the base model *display name*** (`ModelVersion.baseModel`), e.g. `'Krea 2'`, `'Anima'` — **not** the ecosystem key.

```sql
INSERT INTO "GenerationBaseModel" ("baseModel") VALUES ('Krea 2') ON CONFLICT DO NOTHING;
```

### 2. `AuctionBase` — makes an ecosystem FEATURABLE in auctions (only if it should be a paid featured surface)

`AuctionBase` is the FK anchor for `Auction`/`Bid`/`BidRecurring` (Buzz money + history) and holds runtime economics. **There is no `createAuctionBase` mutation** — a new ecosystem's auction can only be created by raw SQL INSERT today. This is a **deliberate, product-gated step, not automatic**: *generatable ≠ should be featured*. Skip it for video / `modelLocked` / experimental ecosystems unless product wants a paid featured auction for them. Admins tune `active`/`minPrice`/`quantity` afterward via `updateAuctionBase` at [moderator/auctions.tsx](src/pages/moderator/auctions.tsx) (no deploy).

- **`ecosystem` must equal the ecosystem *key*** (`'Anima'`, `'Krea2'`, `'ZImageTurbo'`) — what `getBaseModelGroup(baseModel)` returns and what the feature button matches against. **Not** the display name.
- **Don't touch the two sentinel rows:** `ecosystem = NULL` (Featured Checkpoints) and `ecosystem = 'Misc'` are hand-managed, not per-ecosystem.
- Conventions from existing rows: `type = 'Model'`, default economics `quantity 40, minPrice 100, runForDays 1, validForDays 1, active true`; `name = 'Featured Resources - <displayName>'`; `slug = 'featured-resources-<keylowercased>'` (e.g. key `Krea2` → slug `featured-resources-krea2`).

```sql
INSERT INTO "AuctionBase" (type, ecosystem, name, quantity, "minPrice", active, slug, "runForDays", "validForDays")
VALUES ('Model', 'Krea2', 'Featured Resources - Krea 2', 40, 100, true, 'featured-resources-krea2', 1, 1);
```

**Operational gotcha — new rows don't appear until an `Auction` instance exists.** The `/auctions` sidebar lists currently-running `Auction` instances, not `AuctionBase` rows. New instances are only spawned by the daily `createNewAuctions` step in `handle-auctions.ts` (`startAt <= now < endAt`). So a fresh `AuctionBase` is invisible for **up to 24h**. To surface it immediately, also insert a live `Auction` mirroring the current window (same `startAt`/`endAt` as today's other auctions):

```sql
INSERT INTO "Auction" ("startAt","endAt","quantity","minPrice","auctionBaseId","validFrom","validTo","finalized")
SELECT date_trunc('day', now()), date_trunc('day', now()) + interval '1 day', ab.quantity, ab."minPrice", ab.id,
       date_trunc('day', now()) + interval '1 day', date_trunc('day', now()) + interval '2 day', false
FROM "AuctionBase" ab
WHERE ab.ecosystem = 'Krea2';
```

Surface every INSERT above to the user as SQL that needs to be applied manually to each environment — do not assume they auto-run. State which coverage branch you determined applies, so the reader can check your reasoning rather than just running the SQL.

## Cross-ecosystem compatibility

Cross-ecosystem compatibility (e.g. "Pony LoRAs work on Illustrious checkpoints") is driven **entirely by explicit entries in `crossEcosystemRules`** in [basemodel.constants.ts](src/shared/constants/basemodel.constants.ts). The `parentEcosystemId` relationship does **not** infer compatibility — it exists solely for identity (AIR URN ecosystem, classification) and for support/defaults inheritance.

This is a deliberate separation because `parentEcosystemId` serves identity concerns that are unrelated to compat. For example, `Flux2Klein_9B` / `Flux2Klein_9B_base` / `Flux2Klein_4B` / `Flux2Klein_4B_base` all declare `parentEcosystemId: ECO.Flux2` so their AIRs emit `urn:air:flux2:...`, but their architectures are distinct and LoRAs do NOT cross between the variants.

### When to add rules

Add explicit rules whenever you expect cross-ecosystem LoRAs (or other addon types) to work. Common patterns:

- **Parent ↔ child ecosystems** (bidirectional, both rules required):

  ```ts
  { sourceEcosystemId: ECO.Parent, targetEcosystemId: ECO.Child, supportType: 'generation', modelTypes: [...], support: 'partial' },
  { sourceEcosystemId: ECO.Child, targetEcosystemId: ECO.Parent, supportType: 'generation', modelTypes: [...], support: 'partial' },
  ```

- **Sibling ecosystems** (both directions between each pair, e.g. Pony ↔ Illustrious ↔ NoobAI is 6 rules)
- **Unidirectional compat** (e.g. base model LoRAs work on distilled variant but not reverse — add only the supported direction)

### Which `modelTypes` list to use

- `[ModelType.LORA]` — most common; LoRAs trained on one variant work on another
- `sdxlCrossAddonTypes` — for SDXL parent↔child (includes VAE, TextualInversion, LoRA variants)
- `sdxlSiblingAddonTypes` — for SDXL sibling↔sibling (excludes VAE)
- Custom array — for ecosystem-specific cases (e.g. `[ModelType.TextualInversion]` for SD1→SDXL)

### The target-root fallback

`getGenerationSupport` has a fallback: if no direct rule matches, it retries using the checkpoint ecosystem's root (via `parentEcosystemId` chain). This means **one rule targeting a root ecosystem covers all its children**. Example: `SD1 TextualInversion → SDXL` automatically extends to Pony, Illustrious, and NoobAI.

Use this to avoid combinatorial rule duplication, but **be aware**: adding a rule that targets a root ecosystem (e.g. `targetEcosystemId: ECO.Flux2`) would apply it to every child (Flux2Klein variants included) — even if that wasn't the intent. When unsure, prefer explicit per-child rules.

### Checklist when adding a new ecosystem with cross-compat

1. Identify each cross-compatible peer ecosystem.
2. For each pair, add rules in the correct direction(s).
3. Pick the appropriate `modelTypes` set — don't default to "all" without checking what actually works.
4. If children share a root and ALL children should support the same cross rule, target the root to avoid duplication. Otherwise list each child.
5. If the ecosystem has `parentEcosystemId` purely for identity (not compat — like Flux2Klein variants), add explicit cross rules (if any) only for the pairs that truly work — **do not rely on the parent chain**.

## Gotchas

### Always use the `images` node — never `sourceImage` or a singular `image` node

**Uniformity decision:** every image input in a generation graph uses the shared `imagesDef` (`.field('images', imagesDef({ slots }))`), even when a workflow accepts exactly one image — give it a single slot instead of introducing a singular `sourceImage` (or `image`) field. Handlers read `data.images[0]`.

- Single-image example: see `img2imgImages` in `src/shared/form-graph/generation/defs.ts`.
- `normalizeInput` (in `orchestration-new.service.ts`) folds any legacy `sourceImage` into `images[]`, so older stored/remixed data still resolves — do **not** reintroduce or depend on `sourceImage`.
- Exception: a per-entry `image` field *inside a list node* (controlnet entries, Krea2 style references — each `{ image, strength }`) is a different shape and stays `image`; those are not top-level source images.

### Don't use `.effect()` to reset slider values across variants

Tempting pattern (DO NOT use):

```ts
// ❌ WRONG — clobbers user values
.effect(
  (ctx, _ext, set) => {
    const isTurbo = ctx.variant === 'turbo';
    set('cfgScale', isTurbo ? 1 : 5);
    set('steps', isTurbo ? 4 : 20);
  },
  ['variant']
)
```

Why it's wrong:

1. **It overwrites localStorage values.** The user's tuned cfg/steps for the variant they actually use get wiped on every graph evaluation.
2. **It runs server-side too.** When the submission is validated through the graph on the server, the effect fires and overwrites whatever the user just submitted — they get the defaults instead of their input.
3. **It's unnecessary.** `sliderDef` already clamps via `snapToStep(val, step, min, max)` in its zod transform ([defs.ts](src/shared/form-graph/defs.ts)), so an out-of-range value persisted from one variant gets auto-corrected to the new variant's range on the next pass. No effect needed.

Correct pattern: declare the defaults on each branch arm's `sliderDef` and let zod handle clamping.

```ts
// ✅ CORRECT — defaults live on the slider def itself
const normal = defineGraph<FamilyExt>({ scope: familyScope })
  .field('cfgScale', sliderDef({ min: 1, max: 20, defaultValue: 5, step: 0.5 }))
  .field('steps', sliderDef({ min: 1, max: 50, defaultValue: 20 }));

const turbo = defineGraph<FamilyExt>({ scope: familyScope })
  .field('cfgScale', sliderDef({ min: 1, max: 2, defaultValue: 1, step: 0.1 }))
  .field('steps', sliderDef({ min: 1, max: 12, defaultValue: 4 }));
```

The `.effect()` mechanism is fine for *derived* state that the user shouldn't be editing directly (e.g. computed flags). It is NOT fine for slider values the user has agency over.

### Turbo/distilled variants need per-model storage scoping

When the new ecosystem ships a **turbo (or distilled) variant alongside a base variant** with meaningfully different `cfgScale` / `steps` ranges, the variants will trample each other's stored values without an extra step. Example: a user sets cfg=8 on base, switches to turbo (max=2), `snapToStep` clamps to 2 and persists; switching back to base now shows cfg=2 instead of the prior 8.

The fix is per-FIELD, not per-ecosystem: declare those sliders with `perModelSlider` from
[`shared.ts`](src/shared/form-graph/generation/shared.ts) instead of `sliderDef`. It appends the
model version id as a relative scope segment to the family bucket the graph inherits, so each
variant stores `cfgScale`/`steps` under its own address. There is no ecosystem list to register in.

```ts
import { perModelSlider } from '../shared';

.field('cfgScale', perModelSlider({ min: 1, max: 20, defaultValue: 5, step: 0.5 }))
.field('steps', perModelSlider({ min: 1, max: 50, defaultValue: 20 }))
```

`minimax-turbo-scope.test.ts` pins the behaviour.

Skip this if the variants share the same slider ranges (e.g. version bumps with identical capabilities) — there's nothing to trample in that case.

## Common patterns reference

| Pattern | Reference file |
|--------|----------------|
| Simple image ecosystem (comfy) | `form-graph/chroma.handler.ts`, `image/chroma.graph.ts` |
| Image ecosystem with version variants (different types per variant) | `form-graph/ernie.handler.ts`, `image/ernie.graph.ts` |
| Image ecosystem with version-dependent defaults (same shape) | `form-graph/seedream.handler.ts`, `image/seedream.graph.ts` |
| Simple video ecosystem | `form-graph/seedance.handler.ts`, `video/seedance.graph.ts` |
| Complex video ecosystem (txt/img/ref variants) | `form-graph/vidu.handler.ts`, `video/vidu.graph.ts` |
| Image+video on one ecosystem | `form-graph/grok.handler.ts`, `image/grok.graph.ts` + `video/grok.graph.ts` |

## Notes

- **Always check `@civitai/orchestration-client` first.** Skipping this step leads to hand-rolled types that drift from the orchestrator API.
- **`engine` string conventions**: `'comfy'` uses a separate `ecosystem` field; most other engines (`'sdcpp'`, `'seedance'`, `'vidu'`, etc.) use the engine string directly.
- **Sampler/scheduler**: if the provider recommends a single fixed sampler+scheduler, hardcode them in the handler rather than creating UI controls. Simpler UX and avoids bad user choices.
- **Model-locked ecosystems**: set `modelLocked: true` in `ecosystemSettings.defaults` unless the ecosystem has multiple user-selectable checkpoints. This is **not** only a form setting — `isGenerationEligible` reads the same flag through `isModelLockedBaseModel` and holds every Checkpoint on the ecosystem to the LIVE coverage column, so the staged expansion stops making community checkpoints there generatable or loadable (an `EcosystemCheckpoints` row or an auction win still does). Clearing the flag restores them on the next request. Nothing else to update: no migration, no view change, no backfill.
- **Aspect ratio source**: prefer HuggingFace model card recommended resolutions over round-number guesses. They affect output quality significantly.
- **~1M-pixel diffusion models (SDXL-style bucketing)**: don't write a bucket list. Use `SDXL_FULL_AR` (from `../defs`) — the nine SDXL buckets 21:9 → 9:21 with a 3:2 / 1:1 / 2:3 first row. Before you do, read the width/height attributes on the engine's input class in `civitai-orchestration` (`Grains.Abstractions/Workflows/Steps/ImageGen/**`): the comfy inputs take `[Range(64, 2048)] [DivisibleBy(16)]`, so all nine fit, but a provider API can be tighter — BFL's `flux1-pro` caps each side at 1440, so Flux.1 Pro uses `FLUX1_PRO_AR`, which drops 21:9 and 9:21. Any ratio that fits the engine's limits is valid; the buckets are about quality, not acceptance.
- **Custom width × height**: the `SDXL_FULL_AR*` / `FLUX1_PRO_AR` defs carry `custom` limits from `generation.constants.ts` (SD1 passes `sd1CustomDimensionLimits` itself in `sd.graph.ts`), which add a "Custom" entry to the picker. A request opts in with `value: CUSTOM_ASPECT_RATIO` and is fitted by `fitCustomDimensions` (step, side range, area and ratio caps) in the def's `input` and `correct` — so the server enforces it on every parse. Pick the group from what the model's authors document, not from what the engine accepts: `sdxlCustomDimensionLimits` / `SDXL_FULL_AR` (~1 MP: warn past 1 MP, cap 1536²), `twoMegapixelCustomDimensionLimits` / `SDXL_FULL_AR_2MP` (documented to ~2 MP: warn past 2), `fourMegapixelCustomDimensionLimits` / `SDXL_FULL_AR_4MP` (documented to ~4 MP). MP is `MEGAPIXEL` = 1024² px, and **no image may pass 4 MP = 2048²** — a product rule. `maxArea` is enforced; `recommendedArea` only warns. The Custom segment opens `CustomDimensionsModal`: its sliders grey what `sideRange` rules out, and its ratio buttons (`atRatio`) change the shape at the current pixel count. An ecosystem without `custom` snaps a custom value to its nearest bucket. Users can save custom sizes (`GenerationSizePreset`): one list per user, offered on every model whose limits accept a size unchanged and greyed out where they don't, so a new limits object needs nothing extra; add it to `allCustomDimensionLimits` so the server accepts sizes only it allows.
- **Aspect ratio order**: declaration order does not matter — `AspectRatioInput` sorts every list widest first, and a pick from "More" takes its neighbour's slot in that order. Declare widest first anyway, so the data reads the way it displays.
- **Aspect ratio `priorityOptions`**: when an ecosystem exposes more than ~5 aspect ratios, pass `priorityOptions` to `aspectRatioDef` so the UI shows a standard preferred subset up front and tucks the rest behind the "More" overflow. Use the standard preferred set `['16:9', '4:3', '1:1', '3:4', '9:16']` (as Lens and NanoBanana do) when the ecosystem supports those ratios; substitute the nearest available ratio for any it lacks (e.g. Krea2 uses `4:5` in place of `3:4`). Without `priorityOptions`, the picker fills the row from the middle of the sorted list, which is rarely the set you'd choose. On a phone, "More" opens the shared `MobileMenuDrawer` bottom sheet rather than a popover — nothing to wire.
