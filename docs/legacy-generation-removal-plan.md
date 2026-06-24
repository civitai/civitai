# Legacy Generation Removal

Record of retiring the legacy generation submission / formatting / metadata code, now that the
generation graph (`generateFromGraph` / `whatIfFromGraph` + `formatGenerationResponse2`) is the single
path. Follow-on to the comics → generationGraph port
([`comics-generation-graph-port.md`](./comics-generation-graph-port.md)).

## Decisions (context)

- **Shared preset service** — `src/server/services/orchestrator/preset-image-gen.service.ts`: one
  service for comics, the iterate editor, and the enqueued-panels job (their model-config maps were
  ~90% duplicated). "Preset" = app-driven generation against a locked model version, vs the
  user-selected model the main generator form produces.
- **Audit (option c)** — the explicit `auditPromptServer` is kept **only** in the enqueued-panels job
  (it runs outside tRPC, so an early gate there is defensible). Comics + the iterate editor rely on
  `generateFromGraph`'s internal audit, avoiding a double-audit on the interactive paths.
- **Video config + normalize-meta** — full removal; live symbols sourced from the graph/handler files.

## Phase 1 — `imageGen.ts` removed ✅

Extracted the shared `preset-image-gen.service.ts`; repointed `comics.router`, the iterate endpoints
(`iterateGenerate` / `getIterateCostEstimate` — now thin handlers, `ITERATE_MODEL_CONFIG` deleted), and
`process-enqueued-comic-panels.ts` at it; deleted `src/server/services/orchestrator/imageGen/imageGen.ts`.

## Phase 2 — video config layer removed ✅

All 10 video ecosystem `*.schema.ts` files + the `VideoGenerationConfig2` factory
(`infrastructure/GenerationConfig.ts`) + the `videoGenerationConfig2` registry were deleted. Video
generation runs entirely through the graph (every ecosystem has a graph + handler); the schema configs
were dead runtime code.

- The `src/shared/data-graph/generation/*` files define their own constants — they do **not** import
  the legacy schemas. Only 3 server files imported any video schema, and only from `wan`/`veo3`.
- **`generation.config.ts`** reduced to a types-only module exporting `OrchestratorEngine2` (explicit
  literal union). (`VideoGenerationSchema2` was added here, then removed in Phase 3 — see below.)
- **8 schema files deleted outright** (zero importers): `minimax`, `mochi`, `lightricks`, `haiper`,
  `vidu`, `sora`, `kling`, `hunyuan` (empty folders removed).
- **wan/veo3 live symbols relocated into the handler layer** (decision: handler files, move-as-is):
  `veo3.handler.ts` → `getVeo3ProcessFromAir` (+ `veo3ModelOptions`); `wan.handler.ts` →
  `wanBaseModelGroupIdMap` (the others — `wanVersionMap` / `getWanVersion` / `wan21BaseModelMap` /
  `wanGeneralBaseModelMap` — were relocated but then pruned once Phase 3/4 removed their consumers).
- **`orchestrator/generation/generation.schema.ts` deleted** — entirely dead (not to be confused with
  the live `src/server/schema/generation.schema.ts`). The `orchestrator/generation/` folder now holds
  only `generation.config.ts`.

## Phase 3 — legacy `orchestrator/common.ts` removed ✅

The legacy `formatGenerationResponse` is no longer the feed's formatter (`formatGenerationResponse2`
in `orchestration-new.service.ts` is). A full dependency trace showed the only symbol external code
imported from `common.ts` was `updateWorkflow`.

- **Deleted** `comfy/comfy.ts`, `textToImage/textToImage.ts`, and the unused API endpoint
  `pages/api/generation/workflows/[workflowId]/index.ts`. Kept `comfy/comfy.utils.ts` +
  `comfy/comfy.types.ts` (live).
- **`common.ts` deleted** — `updateWorkflow` moved into `orchestration-new.service.ts` (next to
  `formatGenerationResponse2`, which it calls), `orchestrator.router.ts` repointed. The whole orphaned
  closure went with it: the `formatGenerationResponse` formatter tree (incl. `formatVideoGenStep`),
  `parseGenerateImageInput` + its resource helpers, the dead `getGenerationStatus` /
  `getGenerationStatusLimits` duplicates (live code uses the `generation.service` versions), and the
  associated types.
- **Knock-on:** deleting `formatVideoGenStep` removed the last consumer of `VideoGenerationSchema2`, so
  it was deleted from `generation.config.ts` too.

## Phase 4 — `normalize-meta.service.ts` removed ✅

The remix / "generate from this image" pipeline ran `normalizeMeta` as a pre-step before
`mapDataToGraphInput`; most of it was redundant with the mapper. Removed the file (used by only 2 sites
in `generation.service.ts`: `getMediaGenerationData` + `resolveImageMeta`).

- `cleanPrompt` + `type`→`process` + ecosystem resolution now run inline at the 2 sites (extracted to
  the shared `resolveGraphParamsFromImageMeta` helper in the same file); raw
  `civitaiResources`/`resources`/`type` are dropped before the mapper.
- **Wan legacy resolution (`processWanVideoGenMeta`) deleted** — generic `'WanVideo'` baseModel +
  version are now resolved by the wan graph (`ecosystemToVersionDef` `extraEcosystems: ['WanVideo']` →
  v2.1 + workflow/resolution effects) and the mapper's `inferBaseModel` / `resolveWorkflow`.
- `getMetaResources` moved into `generation.service.ts` as a local helper.

## Status

Typecheck **fully clean** (after initializing the `event-engine-common` git submodule in this
worktree — it was uninitialized, which is unrelated to these changes), lint 0 errors, prettier applied
throughout.

## Remaining runtime verification

The code typechecks/lints clean, but these paths need exercising against a real DB / orchestrator
before merge:

- **Old Wan video remix** (Phase 4) — generate-from-image for a Wan video stored with a generic
  `'WanVideo'` baseModel: confirm it resolves to the correct version/process now that
  `processWanVideoGenMeta` is gone and the graph does the resolution.
- **Normal image remix** (Phase 4) — prompt prefill + ecosystem/resource filtering.
- **Comics + iterate** (Phase 1) — a free what-if + one real generation per ecosystem, plus one
  enqueued comic panel. Watch **aspectRatio**: the graph snaps dimensions to ecosystem-canonical sizes,
  and the iterate path returns width/height to the client (`pollIterationStatus`).

The earlier "historical video formatting" concern is **moot** — that formatter (`formatVideoGenStep`)
lived only in the dead `formatGenerationResponse` tree the live feed never used, and was deleted in
Phase 3.
