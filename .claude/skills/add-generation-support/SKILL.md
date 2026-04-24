---
name: add-generation-support
description: Wire an existing ecosystem into the generation system. Adds generation support to basemodel.constants.ts, creates graph and handler files, and wires them into the ecosystem discriminator, workflow config, and router. Use after add-ecosystem when you need the ecosystem to show up in the generation form. Always checks @civitai/client for ecosystem-specific types before writing the handler.
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

### 1. Check @civitai/client for ecosystem-specific types

**Always** check the latest published client version, even if types aren't in the currently installed version.

```bash
# Check installed version
grep "@civitai/client" c:/Work/model-share/package.json

# Check latest available
npm view @civitai/client versions --json | tail -20
```

Search the **latest** version's types for the ecosystem:

```bash
cd /tmp && npm pack @civitai/client@<latest-version> 2>/dev/null
tar -xzf civitai-client-<latest-version>.tgz
grep -n "<EcosystemName>\|<ecosystem-name>" /tmp/package/dist/generated/types.gen.d.ts
```

Note what you find (or don't find):

- **Ecosystem-specific types** (e.g., `SeedanceVideoGenInput`, `ComfyErnieStandardCreateImageGenInput`): use them — they give you the exact field shape and strict enum literals
- **Multiple variant types** (e.g., standard vs turbo): the handler will branch on model version and return the appropriate typed input
- **No types at all**: fall back to the generic `ImageGenStepTemplate` / `VideoGenStepTemplate` with a string `engine` field

If the installed version is older than the latest and the latest has useful types, bump:

```bash
pnpm add @civitai/client@<latest-version>
```

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

- **Single model, simple**: one `sliderNode` per parameter, one aspect ratio set. Seedance is a good reference.
- **Multiple versions with same controls but different defaults**: use `createCheckpointGraph` with `versions.options`. Parameter defaults can vary via `ctx.model?.id` checks. Seedream is a reference.
- **Multiple versions with different capability sets**: use a computed `<name>Variant` discriminator and branch into separate subgraphs. Ernie is a reference — base has LoRAs, turbo doesn't.
- **Model-dependent defaults on the same node key**: if both variants have `cfgScale` but different defaults, add an effect on the parent graph that resets values when the variant changes. The discriminator alone won't override the form's persisted value because it's still valid in the new branch's range.

### 4. Confirm the plan with the user

Summarize:

```
Adding generation support for: <EcosystemName>

Graph: src/shared/data-graph/generation/<name>-graph.ts
- Versions: <list with IDs>
- Aspect ratios: <list>
- Sliders: cfgScale (<range>, default <n>), steps (<range>, default <n>)
- Features: [resources, negativePrompt, images for I2V, etc.]
- Structure: [single graph | discriminator with subgraphs | version-dependent defaults]

Handler: src/server/services/orchestrator/ecosystems/<name>.handler.ts
- Types: <from @civitai/client, or generic>
- Step type: <imageGen | videoGen | textToImage>
- Fixed params: sampler=<x>, scheduler=<y> (if applicable)

Wiring:
- basemodel.constants.ts: uncomment/add ecosystem support + settings
- workflows.ts: add to <TXT2IMG_IDS | TXT2VID_IDS | etc.> and NEW_FORM_ONLY
- ecosystem-graph.ts: add to grouped discriminator
- ecosystems/index.ts: import, type, export, router case
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

#### 5b. `src/shared/data-graph/generation/config/workflows.ts`

- Add `ECO.<Name>` to the appropriate workflow array (`TXT2IMG_IDS`, `TXT2VID_IDS`, `EDIT_IMG_IDS`, `I2V_ONLY_IDS`, etc.)
- Add to the `NEW_FORM_ONLY` rules for every workflow the ecosystem supports (every new ecosystem is new-form-only):
  ```ts
  [
    'txt2img',
    (ecoId, modelId) =>
      // ... existing conditions ...
      ecoId === ECO.<Name>,
  ],
  ```

#### 5c. Create the graph file: `src/shared/data-graph/generation/<name>-graph.ts`

Follow the pattern matching your structural decision from step 3. Key imports:

```ts
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import {
  aspectRatioNode,
  createCheckpointGraph,
  createResourcesGraph,
  imagesNode,
  negativePromptNode,
  seedNode,
  sliderNode,
  // ... etc
} from './common';
```

Exports: always export `<name>VersionIds` (as `const` object) so the handler can import it for version-to-model-string mapping.

#### 5d. Create the handler file: `src/server/services/orchestrator/ecosystems/<name>.handler.ts`

Template:

```ts
import type {
  <EcosystemSpecificInputType>, // e.g., SeedanceVideoGenInput
  <StepTemplateType>,            // ImageGenStepTemplate | VideoGenStepTemplate | TextToImageStepTemplate
} from '@civitai/client';
import { removeEmpty } from '~/utils/object-helpers';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation/generation-graph';
import { <name>VersionIds } from '~/shared/data-graph/generation/<name>-graph';
import { defineHandler } from './handler-factory';

type EcosystemGraphOutput = Extract<GenerationGraphTypes['Ctx'], { ecosystem: string }>;
type <Name>Ctx = EcosystemGraphOutput & { ecosystem: '<Name>' };

export const create<Name>Input = defineHandler<<Name>Ctx, [<StepTemplateType>]>((data, ctx) => {
  // Guard on required fields
  if (!data.aspectRatio) throw new Error('Aspect ratio is required');

  // Branch by model version if multiple variants produce different input types
  // For LoRA support: map resources to the format the type expects
  //   - Record<string, number> for comfy-based ecosystems (AIR → strength)
  //   - Record<string, ImageJobNetworkParams> for textToImage
  //   - Array of { air, strength } for some video types

  return [
    {
      $type: '<imageGen | videoGen | textToImage>',
      input: removeEmpty({
        engine: '<engine>',
        // ecosystem: '<name>',  // only for comfy engine
        // operation: 'createImage' | 'editImage',  // only when the type requires it
        prompt: data.prompt,
        // ... other fields
        seed: data.seed,
      }) as <EcosystemSpecificInputType>,
    } as <StepTemplateType>,
  ];
});
```

Key points:
- Use `removeEmpty` to strip undefined values
- Cast the input to the ecosystem-specific type so TypeScript validates field names and enum values
- For resources, use `ctx.airs.getOrThrow(resource.id)` to get the AIR string

#### 5e. `src/shared/data-graph/generation/ecosystem-graph.ts`

Two edits:

1. Import the graph:
   ```ts
   import { <name>Graph } from './<name>-graph';
   ```

2. Add to the `groupedDiscriminator`:
   ```ts
   { values: ['<Name>'] as const, graph: <name>Graph },
   ```

   Place it with its category (image ecosystems vs video ecosystems) — match the existing groupings.

#### 5f. `src/server/services/orchestrator/ecosystems/index.ts`

Four edits:

1. Import the handler:
   ```ts
   import { create<Name>Input } from './<name>.handler';
   ```

2. Add the context type:
   ```ts
   export type <Name>Ctx = EcosystemGraphOutput & { ecosystem: '<Name>' };
   ```

3. Export the handler:
   ```ts
   export { create<Name>Input } from './<name>.handler';
   ```

4. Add the switch case in `createEcosystemStep` (in the right section comment block):
   ```ts
   case '<Name>':
     return create<Name>Input(normalizedData, handlerCtx);
   ```

### 6. Typecheck

```bash
pnpm run typecheck
```

If there are errors, iterate until clean. Common failures:

- **Ecosystem-specific type not found in @civitai/client**: fall back to generic `ImageGenStepTemplate`/`VideoGenStepTemplate` with `as <Type>` casts.
- **Discriminator value not in union**: verify the value in `ecosystem-graph.ts` `groupedDiscriminator` matches the case in `ecosystems/index.ts` exactly (case-sensitive).
- **Graph context missing a key**: the ecosystemGraph shared nodes (`prompt`, `enhancedCompatibility`) expect certain keys — don't redefine them in your ecosystem subgraph.

### 7. Verify in the form (optional but recommended)

If a dev server is running (check via the `dev-server` skill), ask the user to:
- Select the new ecosystem in the form
- Verify controls render correctly
- Verify the whatIf query returns without errors

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

## Common patterns reference

| Pattern | Reference file |
|--------|----------------|
| Simple image ecosystem (comfy) | `chroma.handler.ts`, `chroma-graph.ts` |
| Image ecosystem with version variants (different types per variant) | `ernie.handler.ts`, `ernie-graph.ts` |
| Image ecosystem with version-dependent defaults (same shape) | `seedream.handler.ts`, `seedream-graph.ts` |
| Simple video ecosystem | `seedance.handler.ts`, `seedance-graph.ts` |
| Complex video ecosystem (txt/img/ref variants) | `vidu.handler.ts`, `vidu-graph.ts` |
| Image+video on one ecosystem | `grok.handler.ts`, `grok-graph.ts` |

## Notes

- **Always check `@civitai/client` first.** Skipping this step leads to hand-rolled types that drift from the orchestrator API.
- **`engine` string conventions**: `'comfy'` uses a separate `ecosystem` field; most other engines (`'sdcpp'`, `'seedance'`, `'vidu'`, etc.) use the engine string directly.
- **Sampler/scheduler**: if the provider recommends a single fixed sampler+scheduler, hardcode them in the handler rather than creating UI controls. Simpler UX and avoids bad user choices.
- **Model-locked ecosystems**: set `modelLocked: true` in `ecosystemSettings.defaults` unless the ecosystem has multiple user-selectable checkpoints.
- **Aspect ratio source**: prefer HuggingFace model card recommended resolutions over round-number guesses. They affect output quality significantly.
