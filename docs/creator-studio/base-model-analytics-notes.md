# Base-model analytics — notes & future work

Context captured 2026-07-22 while building a "video base-model generations/downloads by month" export.
Nothing here is a bug fix — the current page is correct for its purpose. These are findings + recommended
revisions for whoever next touches the **Base models** analytics tab (`/analytics/base-models`).

## What the page does today

- **"Your base models"** table — the creator's own models grouped by base model (`getBaseModelPerformance`).
- **"Civitai-wide base-model usage"** trend — platform-wide generations/downloads per base model, top-20 with
  a comparison-month overlay (`getBaseModelTrends`, `apps/creator-studio/src/lib/server/base-model-trends.ts`).

Both **`GROUP BY baseModel`** on the raw DB string, and both read the same two ClickHouse tables (below).

## Data sources (so nobody re-derives these)

| Source | What it measures | Key |
|---|---|---|
| `orchestration.daily_resource_generation_counts` | **Resource-attributed** generations — a generation that used an uploaded resource (LoRA/checkpoint) | `modelVersionId`, `createdDate` (unpartitioned; sort key leads with `modelVersionId`) |
| `default.daily_downloads` | Resource file downloads | `modelId, modelVersionId, createdDate` (unpartitioned — constrain `modelId` too, see below) |
| `civitai_pg.ModelVersion` | Postgres mirror in ClickHouse; supplies `baseModel` for the join | `id` (→ `modelVersionId`), `modelId`, `baseModel String` |
| `orchestration.jobs` | **Engine-level** generation — one row per generation job, incl. hosted/API engines | `jobType` (LowCardinality), `createdAt`, `resourcesUsed Array(Int32)`, `provider` |

Perf note: `daily_downloads` is unpartitioned and sorted `(modelId, modelVersionId, …)`, so filtering on
`modelVersionId` alone full-scans it — always also constrain `modelId` (callers already resolve it). Same class
of fix landed in `models-earnings.ts`.

## The two generation metrics are different things

- **Resource-attributed** (`daily_resource_generation_counts`) — what the page uses. Counts generations that
  used a creator's uploaded resource. **Correct for a creator-facing tool**: a creator's own models table, and
  "which open-weight ecosystems are creators building resources for."
- **Engine-level** (`orchestration.jobs`, `count()` of generation jobs) — captures **every** generation incl.
  hosted/API engines (Kling, Sora, Veo, Seedance, Vidu) that have **no downloadable resource** and therefore
  register ~0 in the resource-attributed view.

They do not share a unit and should never be summed. The page deliberately uses the resource-attributed metric;
only switch/blend if the goal changes to "represent hosted/API video engines," which is arguably out of scope
for a resource-monetization tool.

`orchestration.jobs` video generation jobTypes (last 12 mo, for reference): `fal-wan-video`, `alibaba-wan-video`,
`comfyLtx23VideoGen`, `comfyLtx2VideoGen`, `kling`/`kling-v3`, `seedance-video`, `vidu`, `fal-sora-video`,
`googleVeo3Video`, plus `fal-grok-video` (Grok — a video engine). **`comfyVideoGen` is a generic ComfyUI
workflow with no engine tag** — open-weight video (Hunyuan/Mochi/CogVideoX/SVD, and Comfy-run Wan/LTXV) pools
there and can only be split by joining `resourcesUsed → civitai_pg.ModelVersion.baseModel`.

## Recommended revisions (in priority order)

1. **Group by ecosystem/family, not the raw `baseModel` string.** Today "Wan" is ~10 separate lines
   (`Wan Video 14B t2v`, `Wan Video 2.2 I2V-A14B`, …), LTXV is 3, and image families fragment too
   (`SD 1.5` / `SD 1.5 LCM` / `SD 1.5 Hyper`; `SDXL 1.0` / `SDXL Lightning`; Flux variants). No single line
   represents the ecosystem, so large families look small/scattered in the top-20. **Add an ecosystem/family
   rollup** (at least a toggle on the platform trend). This is the manual rollup we kept doing for the exports.

2. **Label the generations metric.** On the platform trend, clarify it's "generations using an uploaded
   resource" so a low video number isn't misread as "no demand" (hosted/API engines can't appear here).

3. **Pick a constants source of truth.** Two files exist:
   - `src/shared/constants/base-model.constants.ts` (older) — flat `baseModelConfig` with `type: 'image'|'video'`,
     `group`, `engine`. **The `type` field is unreliable for video**: CogVideoX, Mochi, SVD/SVD XT are video
     generators tagged `'image'` (their group *descriptions* say video). Use descriptions/engine, not `type`.
   - `src/shared/constants/basemodel.constants.ts` (newer, no hyphen) — richer **ecosystem → family** hierarchy
     (`ecosystemId`, `familyId`, `parentEcosystemId`, media types, Grok as an ecosystem). This is the file that
     would power revision #1. If the codebase is standardizing on it, align the page's grouping here.

   Note: the spoke (`apps/creator-studio`) is a separate app — it reads `baseModel` strings from the DB and does
   **not** import `src/shared/constants`. A rollup needs that ecosystem mapping made accessible to the spoke
   (replicate a slim map, or wire the shared constant into the spoke build).

## Explicitly out of scope unless asked

- Swapping the page to engine-level (`orchestration.jobs`) generations — changes what the metric *means* for
  creators. Only pursue if the product goal becomes platform-wide engine analytics rather than creator-resource
  analytics.
