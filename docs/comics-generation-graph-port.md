# Comics Generation → generationGraph Port

## Goal

Port the comics builder's image generation off the **legacy orchestrator imageGen path**
(`createImageGen` / `createImageGenStep` + hand-rolled `params`) onto the **new
generationGraph path** (`generateFromGraph` / `whatIfFromGraph`), so comics shares the
same submission, validation, gating, and metadata pipeline as the main generator.

## Current state (legacy)

All comic generation lives in `src/server/routers/comics.router.ts` and funnels through
**one chokepoint**:

- `submitComicGeneration()` (line ~243) → `createImageGen({ params, resources, ... })`
  - Called by 6 sites: lines ~905, ~3168, ~4465, ~4520, ~5821, ~6119
  - Returns `formatGenerationResponse([workflow])[0]`; callers consume `result.id`
- What-if cost estimate (line ~2175): `createImageGenStep` + `submitWorkflow({ whatif })`
  - In `getGenerationCostEstimate`; returns `{ cost, ready }`
- Reads that are submission-agnostic (orchestrator queries by `workflowId`) — **stay as-is**,
  but must be verified to work against graph-submitted workflows:
  - `getWorkflow` (lines ~3389, ~3541, ~4019, ~4304)
  - `updateWorkflow` (line ~4005)
  - `pollIterationWorkflow` (line ~4555)

Comics defines its own `COMIC_MODEL_CONFIG` map (engine / baseModel / versionId / sizes)
for: NanoBanana2, NanoBanana, Flux2, Seedream, OpenAI, OpenAI2, Qwen, SeedreamLite, Grok.

## Target API

```ts
// orchestration-new.service.ts
generateFromGraph({ input, externalCtx, userId, token, isGreen, allowMatureContent,
                    currencies, isModerator, track, tags, ... }) // → formatted { id, ... }
whatIfFromGraph({ input, externalCtx, userId, token, currencies, ... })  // → cost
buildGenerationContext(userTier, features, { id, isModerator })          // → { externalCtx, status }
```

- `input` is graph-shaped and validated by `generationGraph.safeParse(normalizeInput(input), externalCtx)`.
- `generateFromGraph` **enriches resources internally** from `data.model.id` via `getResourceData`
  (orchestration-new.service.ts:305-364) and builds the AIR map. So `input.model` only needs `{ id: versionId }`.

## The crux: building `input` per comic model

Each `COMIC_MODEL_CONFIG` entry maps to an **ecosystem + workflow key**:

| Comic model             | engine   | baseModel  | versionId                 | Likely workflow key                   |
| ----------------------- | -------- | ---------- | ------------------------- | ------------------------------------- |
| NanoBanana2/NanoBanana  | gemini   | NanoBanana | 2725610 / 2436219         | image:create (+ refs → img2img:edit?) |
| Flux2                   | flux2    | Flux.2 D   | 2439067                   | image:create / img2img:edit           |
| Seedream / SeedreamLite | seedream | Seedream   | 2470991 / 2720141         | image:create / img2img:edit           |
| OpenAI / OpenAI2        | openai   | OpenAI     | 2512167 / 2880272         | image:create / img2img:edit           |
| Qwen                    | qwen     | Qwen       | 2552908 (img2img 2558804) | image:create / img2img:edit           |
| Grok                    | grok     | Grok       | 2738377                   | image:create / img2img:edit           |

Open question — **workflow key when reference images are present**. Most of these are
edit-capable ecosystems; the reverse mapper's `refineImg2img` resolves `img2img` vs
`img2img:edit` per ecosystem support. We must pick the right key when `images.length > 0`.

Two strategies for building `input`:

1. **Reuse `mapDataToGraphInput(params, enrichedResources, { stepType: 'image' })`**
   — the existing legacy→graph bridge. Feed it the same `params` object comics builds today.
   Requires enriching the versionId first (to get baseModel/model.type for `model`).
2. **Build `input` directly** — `{ workflow, ecosystem, model: { id }, prompt, aspectRatio:
{ value, width, height }, images, quantity }` and let `generateFromGraph` enrich.

Recommendation: start with (2) for a single model (NanoBanana2, the default) to prove the
shape end-to-end via `whatIfFromGraph`, then generalize. Fall back to (1) if direct input
hits validation gaps.

## Plan

1. **Add a `buildComicGraphInput(modelConfig, { prompt, images, aspectRatio, width, height,
quantity, versionIdOverride })` helper** that returns the graph `input` object, resolving
   ecosystem + workflow key (txt2img→`image:create`; with refs→edit variant per ecosystem).
2. **Rewrite `submitComicGeneration`** to: build input → `buildGenerationContext` →
   `generateFromGraph`. Preserve the return contract (`.id`) and the `auditPromptServer` call
   (generateFromGraph already audits, so drop the duplicate). Keep `comics`/`green` tags via the
   `tags` option.
3. **Rewrite the what-if path** (`getGenerationCostEstimate`, ~2175) to `whatIfFromGraph`.
4. **Verify reads** — confirm `getWorkflow`/`updateWorkflow`/`pollIterationWorkflow` behave
   identically against graph-submitted workflows (they key off `workflowId`, so expected fine).
5. **Special-case the iterate path** — OpenAI2 / gpt-image-2 is explicitly documented to run
   through legacy `createImageGen` → `imageGenConfig` (`openai.config.ts`). Confirm the graph
   path produces the gpt-image-2 input shape for versionId 2880272; if not, this needs the
   openai ecosystem handler to support it.
6. **Typecheck + what-if smoke test each model** (debug endpoint or what-if) before removing
   the legacy imports.

## Resolved (from code + docs research)

**Q1 — exact `input` shape (verified):**

```ts
{
  workflow: 'txt2img',           // base image-create key
  ecosystem: '<ecosystemKey>',   // REQUIRED — must be an `ecosystemByKey` key
  model: { id: versionId },      // checkpoint node accepts {id}; fills model.type itself
  prompt: '<string>',
  aspectRatio: '<string e.g. "3:4">',  // aspectRatioNode snaps a string to nearest option
  quantity: <number>,
  images: [{ url, width, height }],    // OPTIONAL — only when reference images present
}
```

- `workflow`/`ecosystem` are top-level/ecosystem-graph **input** nodes; `model`/`prompt`/
  `aspectRatio`/`images` live in the family subgraph; `quantity` in ecosystemGraph.
- **`normalizeImageWorkflow`** (orchestration-new.service.ts:417-439) auto-converts
  `txt2img` → `img2img:edit` when `images.length > 0` AND `ecosystem` is set AND the
  ecosystem supports `img2img:edit`. So **we pass `workflow: 'txt2img'` always** and let the
  service flip it. (Hence `ecosystem` MUST be in the input for refs to attach.)
- `generateFromGraph` enriches resources internally from `model.id` (no pre-enrichment needed).
- `images` input accepts `{url,width,height}`; output requires width+height (comics has them).

**Q2 — img2img:edit: automatic, no hardcoding.** All comic ecosystems are in `EDIT_IMG_IDS`
(config/workflows.ts) → `isWorkflowAvailable('img2img:edit', ecoId)` is true, so refs route to
`img2img:edit` via the normalizer. Ecosystem keys (note Flux differs from comic `baseModel`):

| Comic model              | comic baseModel | **ecosystem key** |
| ------------------------ | --------------- | ----------------- |
| NanoBanana2 / NanoBanana | NanoBanana      | `NanoBanana`      |
| Flux2                    | Flux.2 D        | `Flux2`           |
| Seedream / SeedreamLite  | Seedream        | `Seedream`        |
| OpenAI / OpenAI2         | OpenAI          | `OpenAI`          |
| Qwen                     | Qwen            | `Qwen`            |
| Grok                     | Grok            | `Grok`            |

**Q3 — gpt-image-2 (OpenAI2, v 2880272): fully supported.** openai-graph.ts maps
`v2: 2880272` → `gpt2` variant; openai.handler.ts builds the gpt-image-2 shape (numeric
width/height, createImage/editImage). No gap — porting is safe.

**Reads are submission-agnostic.** `getWorkflow`/`updateWorkflow`/`pollIterationWorkflow` and
the panel result-parsing read `step.output.images`/`blobs` + comics' own `panel.metadata`
(generationParams/candidateImages) — never legacy `step.metadata.params`. So they keep working
unchanged against graph-submitted workflows.

## Decision (proceeding autonomously)

- Port **all models in one pass** — the chokepoint (`submitComicGeneration`) makes it uniform,
  and per-model risk is low since every ecosystem is verified present + edit-capable.
- Reference images → `img2img:edit` (automatic via normalizer).
- Drop the duplicate `auditPromptServer` in `submitComicGeneration` — `generateFromGraph`
  audits internally (same auditor + XGuard fallback).
- Keep all read/poll paths unchanged.

## Risks (residual)

- `getResourceData` enrichment requires the comic versionIds to be generatable by the user —
  same constraint the legacy path had (resources passed by id), so no regression expected.
- aspectRatio snaps to the **ecosystem's** canonical dimensions, which may differ slightly from
  comics' bespoke `sizes` width/height. Aspect ratio value is preserved; pixel dims become the
  ecosystem canonical ones. Verify panel dimensions still look right (esp. Qwen/Seedream/OpenAI).
