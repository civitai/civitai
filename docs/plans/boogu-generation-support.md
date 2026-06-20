# Boogu — Generation Support Plan

Status: **PREPPED, not executed.** Ecosystem record already merged (PR #2656: `ECO.Boogu=74`, `BM.Boogu=93`, family 23, Apache-2.0 license id 13). This doc outlines everything needed to wire Boogu into the generator so we can execute fast once the blockers clear.

## What Boogu is

`Boogu-Image-0.1` — unified multimodal image gen + edit. Built on Qwen3-VL-8B-Instruct (understanding) + FLUX.1-dev (generation), ~10B params, Apache-2.0. Three published checkpoints:

| Variant | Task | Steps | CFG | Notes |
|---|---|---|---|---|
| **Base** | text-to-image | 25-50 (def ~35) | 2.0-5.0 (def 4) | text rendering + controllability |
| **Turbo** | text-to-image | 4 | 0.0 | Decoupled-DMD distilled, fast |
| **Edit** | text-guided image-to-image | 25-50 | 2.0-5.0 (def 5) | object/attribute/style edits |

Default resolution 1024x1024 (2K capable). Bilingual (CN/EN) text rendering.

---

## BLOCKERS (must clear before generation works end-to-end)

1. **No `@civitai/client` types for Boogu.** Checked installed (`0.2.0-beta.71`), `latest` tag (`0.1.1-beta.0`), newest `beta` (`0.2.0-beta.72`) — zero `boogu`. ZImage types exist there; Boogu does not. **The orchestrator team must add a Boogu engine and publish typed inputs** (`BooguBaseCreateImageGenInput` / `BooguTurboCreateImageGenInput` / `BooguEditImageGenInput`, names TBD) before the handler can be strictly typed and before whatIf/generation actually succeeds. Until then we can scaffold the graph + UI and a handler with generic `ImageGenStepTemplate` + `as` casts, but it won't run.
2. **Civitai model version IDs — RESOLVED.** The 3 CivitaiOfficial draft checkpoints + their v0.1 version IDs (graph discriminator + `ecosystemSettings.defaults.model.id`):

   | Variant | Model ID | Version ID |
   |---|---|---|
   | Base  | 2714299 | **3049541** |
   | Edit  | 2714541 | **3049824** |
   | Turbo | 2714686 | **3050010** |

   ```ts
   const booguVersionIds = { base: 3049541, edit: 3049824, turbo: 3050010 } as const;
   ```

   Base-model flip (Other -> Boogu) script: `C:\Users\Zipp4\AppData\Local\Temp\boogu-flip.mjs` (dry-run default; `--execute` to write). Validated via dry-run; run after the v5.0.1868 deploy is live in prod.
3. **Engine string + edit operation contract — orchestrator's call.** ZImage uses `engine: 'sdcpp', ecosystem: 'zImage'`. Boogu's engine (comfy? sdcpp? a new one?) and whether edit is `operation: 'editImage'` vs image-presence-inferred is whatever the orchestrator implements. Confirm with orchestrator team.

## Gating mechanism (answer to "Flipt or ecosystem mgmt?")

**Not Flipt.** Recent ecosystems (ZImage, Ideogram, Ernie, Krea2) have **no** Flipt flags. Visibility is gated by flags on the `BaseModelRecord` in `basemodel.constants.ts`:
- `hidden: true` — not user-facing yet (Imagen4, NanoBanana, OpenAI, SCascade all use this)
- `disabled: true` — root-level disable of all support
- `experimental: true` — shown but flagged experimental (Qwen)

Plan: ship the graph/handler with `BM.Boogu` marked `hidden: true`, flip to visible when orchestrator + versions are ready. No Flipt work needed.

---

## Architecture decision: ONE ecosystem, model.id discriminator

You wanted a single "Boogu" ecosystem. That fits the modern pattern and we don't need ZImage's two-ecosystem split.

- **ZImage** modeled Turbo/Base as **two ecosystems** (`ZImageTurbo`, `ZImageBase`) sharing one graph, discriminated on `ctx.ecosystem`.
- **NanoBanana / Qwen2 / Flux2** model **multiple modes in ONE ecosystem**, discriminated on `model.id`, and handle txt2img-vs-edit in the same ecosystem by appearing in both `TXT2IMG_IDS` and `EDIT_IMG_IDS` with a handler that branches on image presence.

**Recommendation: mirror NanoBanana.** One `Boogu` ecosystem, computed discriminator on selected `model.id` → 3 subgraphs (Base / Turbo / Edit), each declaring its own `cfgScale`/`steps` `sliderNode` defaults+ranges. Edit subgraph enables the `images` node; Base/Turbo don't. Register `ECO.Boogu` in both `TXT2IMG_IDS` (Base/Turbo) and `EDIT_IMG_IDS` (Edit). Handler sets `operation: 'editImage'` when `hasImages`, else `'createImage'`.

This keeps it to the single ecosystem you asked for while supporting all 3 variants.

---

## File-by-file changes

### 1. `src/shared/data-graph/generation/boogu-graph.ts` (NEW)

Mirror `nano-banana-graph.ts` (3-mode, model.id discriminator) + `z-image-graph.ts` (turbo slider ranges). Structure:

```ts
const booguVersionIds = {
  base:  <BASE_VERSION_ID>,   // BLOCKER #2
  turbo: <TURBO_VERSION_ID>,
  edit:  <EDIT_VERSION_ID>,
} as const;

// Turbo subgraph: cfgScale {min:1,max:2,step:0.1,default:1} (orchestrator clamps CFG 0)
//                 steps {min:1,max:12,default:4}; NO sampler/scheduler; NO images node
// Base subgraph:  cfgScale {min:1,max:8,step:0.5,default:4}
//                 steps {min:1,max:50,default:35}; NO images node
// Edit subgraph:  cfgScale {min:1,max:8,step:0.5,default:5}
//                 steps {min:1,max:50,default:35}
//                 images node: when !ctx.workflow.startsWith('txt'), imagesNode({ max: 1 })  // confirm max
//
// .computed('booguMode', ctx => mode-from-model.id, ['model'])
// .groupedDiscriminator('booguMode', [{turbo},{base},{edit}])
```

- Declare slider defaults **on each subgraph** — do NOT use `.effect()` to reset across variants (clobbers stored values + fires server-side; see skill gotcha).
- Aspect ratios: use `sdxlAspectRatioBuckets` (FLUX-based), default `1:1`, 1024-centric. Add `priorityOptions: ['16:9','4:3','1:1','3:4','9:16']` if >5 ratios.
- Resources/LoRA: Boogu is FLUX.1-dev-based → **could** support community LoRAs. Default to `createResourcesGraph` merge (like ZImage) but confirm orchestrator accepts them; if not, drop.
- Export `booguVersionIds` for the handler.

### 2. `src/server/services/orchestrator/ecosystems/boogu.handler.ts` (NEW)

Mirror `nano-banana.handler.ts` / `flux2.handler.ts`:

```ts
const hasImages = !!data.images?.length;
const operation = hasImages ? 'editImage' : 'createImage';
return [{
  $type: 'imageGen',
  input: removeEmpty({
    engine: '<ENGINE>',            // BLOCKER #3
    // ecosystem: 'boogu',         // only if comfy/sdcpp engine
    model: <map model.id -> 'base'|'turbo'|'edit'>,
    operation,                     // if orchestrator requires it
    prompt: data.prompt,
    images: hasImages ? data.images?.map(x => x.url) : undefined,
    aspectRatio: data.aspectRatio?.value,
    cfgScale: 'cfgScale' in data ? data.cfgScale : undefined,
    steps: 'steps' in data ? data.steps : undefined,
    seed: data.seed,
  }) as <BooguInputType>,           // BLOCKER #1 — generic ImageGenStepTemplate cast until client ships
}];
```

### 3. `src/shared/constants/basemodel.constants.ts`

- **`ecosystemSupport`**: add `{ ecosystemId: ECO.Boogu, supportType: 'generation', modelTypes: checkpointAndLora }` (+ training `loraOnly` + auction if we allow LoRA training; else `checkpointOnly`).
- **`ecosystemSettings`**: `{ ecosystemId: ECO.Boogu, defaults: { model: { id: <BASE_VERSION_ID> } } }`.
- **`BM.Boogu` record**: add `hidden: true` until launch-ready (BLOCKER gate).

### 4. `src/shared/data-graph/generation/config/workflows.ts`

- Add `ECO.Boogu` to **`TXT2IMG_IDS`** (Base/Turbo).
- Add `ECO.Boogu` to **`EDIT_IMG_IDS`** (Edit).
- Add `img2img:edit` + `txt2img` entries to `NEW_FORM_ONLY` (every new ecosystem is new-form-only):
  ```ts
  ['txt2img',      (ecoId) => /* ... */ ecoId === ECO.Boogu],
  ['img2img:edit', (ecoId) => /* ... */ ecoId === ECO.Boogu],
  ```

### 5. `src/shared/data-graph/generation/ecosystem-graph.ts`

- `import { booguGraph } from './boogu-graph';`
- Add to `groupedDiscriminator` (image group): `{ values: ['Boogu'] as const, graph: booguGraph },`

### 6. `src/server/services/orchestrator/ecosystems/index.ts`

- `import { createBooguInput } from './boogu.handler';`
- `export type BooguCtx = EcosystemGraphOutput & { ecosystem: 'Boogu' };`
- `export { createBooguInput } from './boogu.handler';`
- switch case: `case 'Boogu': return createBooguInput(normalizedData, handlerCtx);`

### 7. `src/components/generation_v2/GenerationFormProvider.tsx`

- Add `'Boogu'` to `TURBO_VARIANT_ECOSYSTEMS` so `cfgScale`/`steps` scope per `model.id` — Turbo (cfg 0, 4 steps) and Base (cfg 4, ~35 steps) have very different ranges within the one ecosystem and would otherwise trample each other's stored values.

### 8. Typecheck

`pnpm run typecheck` — iterate to clean. Expect type-cast friction from BLOCKER #1 (no client types); use generic `ImageGenStepTemplate` + `as` until the client ships.

---

## UI behavior (free, no extra work)

The image-upload control renders automatically: the Edit subgraph's `images` node (`when: !ctx.workflow.startsWith('txt')`) makes `GenerationForm.tsx`'s `Controller name="images"` render `ImageUploadMultipleInput`. Mask drawing enables when `workflow === 'img2img:edit'`. Driven purely by graph structure + workflow-array membership — no ecosystem flag needed.

---

## Execution order (once blockers clear)

1. Orchestrator ships Boogu engine + publishes `@civitai/client` with Boogu types. → `pnpm add @civitai/client@<ver>`
2. Get the 3 Civitai model version IDs from Justin.
3. Confirm engine string + edit contract + LoRA support with orchestrator.
4. Make edits 1-7 in one pass; typecheck.
5. Verify in local form (dev-server): select Boogu, switch Base/Turbo/Edit, confirm controls + whatIf.
6. Flip `BM.Boogu` off `hidden` to launch.

## Open questions for orchestrator team

- Engine string for Boogu? (`comfy` / `sdcpp` / new?)
- Edit: `operation: 'editImage'` field, or inferred from image presence?
- Community LoRAs on the FLUX.1-dev base — supported?
- Edit input: single source image or multiple? (assumed `max: 1`)
- Turbo CFG truly 0 — does the slider send 0 or does orchestrator hardcode it?
