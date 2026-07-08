# Spec: DB-managed model file precisions & quant types

ClickUp: [868k69pey](https://app.clickup.com/t/868k69pey)

## Goal
Move the two hardcoded model-file metadata lists out of `constants.ts` and into the DB so mods
can edit them without a deploy (these lists grow over time as new GGUF quant types / precisions appear).

- **precisions** (`modelFileFp`): currently `['fp16','fp8','nf4','fp32','bf16']`
- **quantTypes** (`modelFileQuantTypes`): currently 25 `Q*`/`IQ*` values

## Storage
Single `KeyValue` row, key `modelFileOptions`:
```json
{ "precisions": ["fp16", "fp8", ...], "quantTypes": ["Q8_0", "Q6_K", ...] }
```
The hardcoded `constants.modelFileFp` / `constants.modelFileQuantTypes` stay as the **default/fallback**
when the key is absent or unreadable (same layered pattern as `update-user-score` multipliers:
DB → hardcoded default).

## Service
Folded into `src/server/services/model-file.service.ts` (alongside the other model-file CRUD).
Uses `dbKV` (`~/server/db/db-helpers`) for KeyValue access — the repo convention (cf. `system.router`
`getDbKV`, `training.router`). No app-layer cache: caching lives at the edge (`edgeCacheIt` on the
public procedure); `dbKV` is bound to the primary, so a write is self-consistent on the next read.
- `getModelFileOptions()` → `dbKV.get(KEY)`, normalized; falls back to constants defaults when absent.
- `setModelFileOptions` / `addModelFileOptions` / `removeModelFileOptions` ({ precisions?, quantTypes? })
  → read-before-write via a shared `mutateModelFileOptions(input, merge)` helper, then `dbKV.set`.

## Mod management endpoint (webhook, token-secured)
`src/pages/api/admin/model-file-options.ts` using `WebhookEndpoint` (`?token=$WEBHOOK_TOKEN`).
Method-based REST (no `action` param) — the verb says what it does; body `{ precisions?, quantTypes? }`:
- `GET`    → current `{ precisions, quantTypes }` (live, bypasses cache)
- `PUT`    → replace the provided list(s) wholesale
- `POST`   → add value(s) to the existing list(s)
- `DELETE` → remove value(s) from the existing list(s)

Writes read-before-write from the **primary** (`dbWrite`) so a partial mutation can't clobber the
preserved list during replication lag. Body validated: non-empty `string[]`, ≥1 of the two keys.

## Public read (edge-cached, client-facing)
tRPC `modelFile.getOptions` (`src/server/routers/model-file.router.ts`), `publicProcedure` with
`.use(edgeCacheIt({ ttl: CacheTTL.sm, tags: () => [MODEL_FILE_OPTIONS_EDGE_TAG] }))` → 3-min CDN
s-maxage, tagged for purge. Returns `{ precisions, quantTypes }` from the service. Established
edge-cache convention (cf. `system.router` `getDbKV`, `generation.router` tag+purge); the repo's
tRPC client uses non-batched `httpLink` GET so `edgeCacheIt` applies.

**Cache busting:** every mod write (`mutateModelFileOptions`) calls
`purgeCache({ tags: [MODEL_FILE_OPTIONS_EDGE_TAG] })` after `dbKV.set`, so the CDN serves fresh
immediately. Already-loaded browser tabs still refetch on their 3-min React Query `staleTime`.
`purgeCache` no-ops without `CF_ZONE_ID` (dev).

## Client — dropdowns
Shared hook `src/hooks/useModelFileOptions.ts`: `trpc.modelFile.getOptions.useQuery` (staleTime ~3min
to match edge cache), returning `{ precisions, quantTypes }`, falling back to `constants.*` while
loading / on error so dropdowns never render empty.

Wired into all three consumers:
- `src/components/Resource/Files.tsx` — the model file editor (Quant ~984, Precision ~1002) [task target]
- `src/components/Model/Actions/MergeVersions.tsx` (~1053 quant, ~1070 fp)
- `src/components/Account/SettingsCard.tsx` (~118 fp, ~141 quant)

## Server validation (the one real design decision)
The 4 zod schemas use `z.enum(constants.modelFileFp)` / `z.enum(constants.modelFileQuantTypes)`. `z.enum`
is static at module-load, so a newly-added DB value would FAIL upload/download validation — defeating the
feature. Options:
- **A (recommended):** relax those fields to `z.string()` (nullish, with a sane `.max()`); values are
  mod-curated + selected from the editor dropdown, low-risk metadata tags.
- **B:** keep `z.enum` as a superset — new values require also editing constants (defeats the purpose).
- **C:** async-refine each schema against the cached DB list (correct but heavy; schemas are imported in
  sync contexts).

## Out of scope (MVP)
- No in-app mod UI; management is via the webhook endpoint only (matches "like the KoN queues").
- The 4 zod schemas relax to `z.string()` (decision A) — values are mod-curated + dropdown-selected.
