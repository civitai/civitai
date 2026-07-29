# Spec: DB-managed model file precisions & quant types

ClickUp: [868k69pey](https://app.clickup.com/t/868k69pey)

## Goal

Move the two hardcoded model-file metadata lists out of `constants.ts` and into the DB so mods
can edit them without a deploy (these lists grow over time as new GGUF quant types / precisions appear).

- **precisions** (`modelFileFp`): 11 values, best-to-worst `fp32 … int4`
- **quantTypes** (`modelFileQuantTypes`): 34 values — `None` (unquantized) plus the `Q*`/`IQ*`/`TQ*` set

## Storage

Single `KeyValue` row, key `modelFileOptions`:

```json
{ "precisions": ["fp32", "fp16", ...], "quantTypes": ["None", "Q8_0", ...] }
```

The hardcoded `constants.modelFileFp` / `constants.modelFileQuantTypes` stay as the **default/fallback**
when the key is absent or unreadable (same layered pattern as `update-user-score` multipliers:
DB → hardcoded default).

**Array order is UI order.** The dropdowns render the stored arrays verbatim, so both lists are kept
best-quality-first. This is also why a rollout that reorders values must use `PUT` (wholesale replace)
rather than `POST` (which preserves existing order and appends new values to the tail).

### The `None` quant type

`None` is a sentinel meaning "not quantized", not a quantization. It exists so an unquantized GGUF has
a valid answer to the `.gguf`-requires-a-quantType rule without duplicating the precision field as
`F16`/`F32` quant values. It carries behavior that plain list values do not:

- Ranks above every quantized value in `quantQualityRank` (unquantized is the highest quality).
- **Selecting it is the only way to reach the Precision field on a GGUF upload** — the file editor and
  the merge-versions mapper show Precision instead of hiding it when quant is `None`, and a refinement
  then requires a precision. **Deleting `None` from the DB list silently makes Precision unreachable for
  every GGUF, with no error surfaced anywhere.** Do not `DELETE` it.
- Never rendered literally: display helpers show "Unquantized" (`formatQuantType`), and it is filtered
  out of the account-level "Preferred Quant Type" select, where "no preference" is expressed by leaving
  the preference unset.

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

- `GET` → current `{ precisions, quantTypes }` (live, bypasses cache)
- `PUT` → replace the provided list(s) wholesale
- `POST` → add value(s) to the existing list(s)
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

- `src/components/Resource/Files.tsx` — the model file editor (Quant + Precision selects)
- `src/components/Model/Actions/MergeVersions.tsx` — the file mapper's Quant + Precision selects
- `src/components/Account/SettingsCard.tsx` — "Preferred Precision" / "Preferred Quant Type"

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
