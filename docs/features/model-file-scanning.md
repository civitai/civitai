# Model File Scanning

## Overview

When users upload model files to a model version, the system scans them for viruses, dangerous pickle imports, and computes file hashes. We are migrating from a legacy HTTP-based scanner to orchestrator workflows via `@civitai/client`.

## New System: Orchestrator Workflows

### Scan Types

The new system uses three orchestrator workflow step types in a single workflow:

| Step Type | `$type` | Input | Output |
|-----------|---------|-------|--------|
| ClamAV Virus Scan | `modelClamScan` | `{ model: string }` (AIR) | `{ exitCode, output }` |
| Pickle Scan | `modelPickleScan` | `{ model: string }` (AIR) | `{ exitCode, output, globalImports, dangerousImports }` |
| File Hashing | `modelHash` | `{ model: string }` (AIR) | `{ shA256, autoV1, autoV2, autoV3, blake3, crC32 }` |
| Parse Metadata | `modelParseMetadata` | `{ model: string }` (AIR) | `{ metadata: string \| null }` (raw JSON header from safetensors) |

All three steps take a `model` AIR string as input (e.g. `urn:air:sd1:checkpoint:civitai:12345@67890`).

### Workflow Submission

Submit a single workflow with all three steps using `submitWorkflow` from `@civitai/client` with the `internalOrchestratorClient`:

```typescript
import { submitWorkflow } from '@civitai/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';

const { data, error } = await submitWorkflow({
  client: internalOrchestratorClient,
  body: {
    metadata: { fileId, modelVersionId },
    currencies: [],
    tags: ['civitai', 'model-scan'],
    steps: [
      {
        $type: 'modelClamScan',
        name: 'clamScan',
        metadata: { fileId },
        input: { model: air },
      },
      {
        $type: 'modelPickleScan',
        name: 'pickleScan',
        metadata: { fileId },
        input: { model: air },
      },
      {
        $type: 'modelHash',
        name: 'hash',
        metadata: { fileId },
        input: { model: air },
      },
      {
        $type: 'modelParseMetadata',
        name: 'parseMetadata',
        metadata: { fileId },
        input: { model: air },
      },
    ],
    callbacks: [
      {
        url: `${env.WEBHOOK_URL}/api/webhooks/model-file-scan-result?token=${env.WEBHOOK_TOKEN}`,
        type: ['workflow:succeeded', 'workflow:failed', 'workflow:expired', 'workflow:canceled'],
      },
    ],
  },
});
```

### Callback Webhook

Create a new webhook endpoint at `/api/webhooks/model-file-scan-result` following the pattern from `image-scan-result.ts`:

1. Receive `WorkflowEvent` in request body
2. Fetch the full workflow via `getWorkflow({ client: internalOrchestratorClient, path: { workflowId } })`
3. Extract `fileId` from `data.metadata`
4. Process each step's output by `$type`:
   - `modelClamScan` -> update `virusScanResult`, `virusScanMessage`
   - `modelPickleScan` -> update `pickleScanResult`, `pickleScanMessage` (examine dangerous imports)
   - `modelHash` -> upsert `ModelFileHash` records
   - `modelParseMetadata` -> parse JSON string and store in `ModelFile.headerData`
5. On failure (`event.status !== 'succeeded'`), mark file for retry

```
POST /api/webhooks/model-file-scan-result?token=<WEBHOOK_TOKEN>
Body: WorkflowEvent { workflowId, type, status }
```

### Key Implementation Files

| File | Purpose |
|------|---------|
| `src/server/services/orchestrator/orchestrator.service.ts` | **MODIFIED** - Added `createModelFileScanRequest()` alongside existing `createImageIngestionRequest()` |
| `src/server/services/model-file-scan-result.service.ts` | **NEW** - Processes scan workflow results (step outputs -> DB updates) |
| `src/pages/api/webhooks/model-file-scan-result.ts` | **NEW** - Webhook endpoint for scan callbacks |
| `src/server/controllers/model-file.controller.ts` | **MODIFIED** - Triggers scan workflow on file creation |
| `src/server/jobs/scan-files.ts` | **MODIFIED** - Added `scanFilesFallbackJob` that resubmits stalled/pending files via orchestrator |
| `src/pages/api/webhooks/run-jobs/[[...run]].ts` | **MODIFIED** - Registered `scanFilesFallbackJob` |
| `src/pages/api/webhooks/scan-result.ts` | **LEGACY** - Still receives results from the legacy HTTP scanner; to be deleted in cleanup phase |

### AIR String Construction

Each step requires a model AIR string identifying the model file. Use `stringifyAIR` from `~/shared/utils/air`:

```typescript
import { stringifyAIR } from '~/shared/utils/air';

const air = stringifyAIR({
  baseModel: modelVersion.baseModel,
  type: model.type,
  modelId: model.id,
  id: modelVersion.id,
});
```

### Output Type Definitions

Define local types for the step outputs (same pattern as `image-scan-result.service.ts`):

```typescript
type ModelClamScanStep = {
  $type: 'modelClamScan';
  output: { exitCode?: number | null; output?: string | null };
};

type ModelPickleScanStep = {
  $type: 'modelPickleScan';
  output: {
    exitCode?: number | null;
    output?: string | null;
    globalImports?: string[] | null;
    dangerousImports?: string[] | null;
  };
};

type ModelHashStep = {
  $type: 'modelHash';
  output: {
    shA256?: string | null;
    autoV1?: string | null;
    autoV2?: string | null;
    autoV3?: string | null;
    blake3?: string | null;
    crC32?: string | null;
  };
};

type ModelParseMetadataStep = {
  $type: 'modelParseMetadata';
  output: { metadata?: string | null };
};

type ModelScanStep = ModelClamScanStep | ModelPickleScanStep | ModelHashStep | ModelParseMetadataStep;
```

### Result Processing

Map orchestrator exit codes to `ScanResultCode`:

```typescript
// exitCode: 0 = Success, 1 = Danger, 2 = Error, null/-1 = Pending
const exitCodeToScanResult = (exitCode: number | null | undefined): ScanResultCode => {
  switch (exitCode) {
    case 0: return ScanResultCode.Success;
    case 1: return ScanResultCode.Danger;
    case 2: return ScanResultCode.Error;
    default: return ScanResultCode.Pending;
  }
};
```

Hash output maps to `ModelFileHash` records:

| Output Field | `ModelHashType` |
|-------------|-----------------|
| `shA256` | `SHA256` |
| `autoV1` | `AutoV1` |
| `autoV2` | `AutoV2` |
| `autoV3` | `AutoV3` |
| `blake3` | `BLAKE3` |
| `crC32` | `CRC32` |

### Migration from Legacy System

The legacy system in `scan-files.ts` currently:

1. Queries `ModelFile` records where `virusScanResult = Pending`
2. POSTs to `SCANNING_ENDPOINT` with file download URL and callback
3. Receives results at `/api/webhooks/scan-result`

The new system replaces steps 2-3:

- Instead of POST to `SCANNING_ENDPOINT`, submit an orchestrator workflow
- Instead of `/api/webhooks/scan-result`, use `/api/webhooks/model-file-scan-result`
- The orchestrator handles file access via AIR, no need to resolve download URLs
- A 400 response from `submitWorkflow` indicates the file was not found

The `scanFilesJob` in `scan-files.ts` needs to be updated to:

1. Query pending files (same as today, but join through `ModelVersion` -> `Model` for AIR construction)
2. Build AIR strings for each file
3. Submit orchestrator workflows instead of calling `requestScannerTasks()`

### Legacy Tasks Disposition

The legacy scanner supported 5 task types. Here's what happens to each:

| Legacy Task | Status | Notes |
|-------------|--------|-------|
| `Scan` | **Replaced** by `modelClamScan` + `modelPickleScan` steps | Split into two dedicated steps |
| `Hash` | **Replaced** by `modelHash` step | Now returns more hash types (blake3, crc32, autoV3) |
| `ParseMetadata` | **Replaced** by `modelParseMetadata` step | Returns raw JSON header string from safetensors files. Parse and store in `ModelFile.headerData`. See `scan-result.ts:62-69` |
| `Import` | **Move app-side** | Bucket management (upload -> permanent storage). Not a processing task. Handle during upload flow or post-scan callback. See `scan-result.ts:72-78` |
| `Convert` | **Drop** | Pickle-to-safetensors conversion. Never actually requested by any caller — dead code. See `scan-result.ts:132-161` |

### Existing Result Processing to Preserve

The current `/api/webhooks/scan-result` does several things that must carry over:

- **Pickle import examination**: `examinePickleScanMessage()` logic for dangerous vs global imports
- **Hash blocking**: Check if SHA256 matches a blocked hash (`isModelHashBlocked`)
- **Search index update**: Reindex model in Meilisearch after scan
- **Cache busting**: `dataForModelsCache.bust()` and `deleteFilesForModelVersionCache()`
- **Unpublish on missing file**: If file doesn't exist, unpublish the version
- **Hash fix notifications**: Notify users when hash issues are fixed

---

## Rollout Strategy

The new flow runs **side-by-side** with the legacy scanner during rollout, gated by a single Flipt flag so we can flip between them (or disable both for incident response) without redeploying.

### Flipt Flag

```ts
// src/server/flipt/client.ts
export enum FLIPT_FEATURE_FLAGS {
  ...
  MODEL_FILE_SCAN_ORCHESTRATOR = 'model-file-scan-orchestrator',
}
```

**Convention used elsewhere**: server-side checks use `await isFlipt(FLIPT_FEATURE_FLAGS.MODEL_FILE_SCAN_ORCHESTRATOR)`. Default off; flip on after Phase 1 work below is complete.

### Gated Call Sites

| Site | Flag OFF (legacy) | Flag ON (orchestrator) |
|------|-------------------|------------------------|
| `createFileHandler` (post-create scan trigger) | Skip scan; rely on `scanFilesJob` cron | Call `createModelFileScanRequest()` |
| `scanFilesJob` (legacy `*/5 * * * *`) | Runs as today | **Early-return** — prevent double-submit |
| `scanFilesFallbackJob` (new `*/5 * * * *`) | Early-return | Runs as designed |
| `rescanModel()` in `model.service.ts:1132` | Calls `requestScannerTasks()` | Calls `createModelFileScanRequest()` |
| `clean-up.ts:47` (admin) | Calls `requestScannerTasks()` | Calls `createModelFileScanRequest()` |

> ⚠️ Today, both `scanFilesJob` and `scanFilesFallbackJob` are registered and run on the same schedule against the same `Pending` files. Until the flag gate is in place, this **will double-submit** in any environment where both `SCANNING_ENDPOINT` and `ORCHESTRATOR_ACCESS_TOKEN` are configured. The flag gate is a **Phase 1 blocker** — do not deploy without it.

### Rollout Phases

1. **Phase 1 — Parity & gating** (before flag flip): finish the 🔴 items below.
2. **Phase 2 — Canary** (flag at 1% → 10% → 50% → 100% via Flipt segments): monitor for skew between legacy and orchestrator results.
3. **Phase 3 — Cleanup** (flag at 100% for ≥1 week, no regressions): finish the 🟡 items below.

### Monitoring During Rollout

Compare the two paths via Axiom logs (`name: scan-result` vs `name: model-file-scan-result`):

- Workflow submission failures (`createModelFileScanRequest` returns no data)
- Webhook latency (`event.status === 'succeeded'` to DB write)
- Files stuck `Pending` for >24h (Postgres query on `ModelFile`)
- Hash mismatches: re-scan the same file via both paths and compare `ModelFileHash` rows

---

## TODO Tracker

### 🔴 Phase 1 — Required before flag flip

**Flag plumbing**
- [x] Add `MODEL_FILE_SCAN_ORCHESTRATOR` to `FLIPT_FEATURE_FLAGS` in `src/server/flipt/client.ts`
- [x] Gate `createModelFileScanRequest()` call in `createFileHandler` (controllers/model-file.controller.ts:140)
- [x] Gate `scanFilesJob` (early-return when flag ON) and `scanFilesFallbackJob` (early-return when flag OFF) in `src/server/jobs/scan-files.ts`
- [x] Gate `rescanModel()` and `clean-up.ts` admin endpoint to dispatch via the right path

**Service consolidation** (see [Webhook Comparison](#webhook-comparison-legacy-vs-orchestrator) for full delta)
- [x] Extract a shared `applyScanOutcome({ fileId, virusScan, pickleScan, hashes, headerData, modelVersionId? })` from `model-file-scan-result.service.ts` so both webhook adapters can call it
- [x] Both `/api/webhooks/scan-result` and `/api/webhooks/model-file-scan-result` become thin payload normalizers that call `applyScanOutcome()`
- [x] Port pre-existing SHA256/AutoV2 capture (`scan-result.ts:100-107`) — used today for hash-fix notification (D3); SHA256 path remains for when hash-blocking is re-enabled
- [x] **Decision (D2)**: hash-blocking kept commented-out, matching legacy. Re-enabling is a separate decision, tracked in 🟢 below.
- [x] **Decision (D1)**: `rawScanResult` populated with a normalized envelope `{ source: 'orchestrator' | 'legacy', ... }` from both adapters. No schema migration.

**Operational hygiene**
- [x] Failed workflow handling: `applyScanOutcome` now resets `scanRequestedAt = null` when `outcome.failed === true` (D4), so the fallback job picks the file up on its next 5-min tick
- [x] Dev skip when `ORCHESTRATOR_ACCESS_TOKEN` missing in `createModelFileScanRequest()` — fake-success update mirrors legacy behavior
- [x] Removed debug `console.log({ workflowId: data?.id })` in `orchestrator.service.ts`
- [x] Reverted `src/pages/api/admin/test.ts` to its previous `userContentOverviewCache` content
- [x] Restored trailing newline in `package.json`

### 🟡 Phase 3 — Required before legacy removal

These can wait until the flag has been at 100% for ≥1 week with no skew alerts.

- [ ] Delete `src/pages/api/webhooks/scan-result.ts`
- [ ] Delete `scanFilesJob` and `requestScannerTasks()` from `src/server/jobs/scan-files.ts`
- [ ] Drop `SCANNING_ENDPOINT` and `SCANNING_TOKEN` from `env/server.ts` and infrastructure config
- [ ] Remove the `MODEL_FILE_SCAN_ORCHESTRATOR` flag and all gates (full commit to the new path)
- [ ] Drop the `ScannerTasks` / `ScannerTask` exports if nothing consumes them
- [ ] If `rawScanResult` was decided "drop", run the schema migration

### 🟢 Worth considering (decisions, not blockers)

- [ ] **Unpublish on missing file** — legacy unpublishes when scanner reports `fileExists=false`. Orchestrator signals via 400 on `submitWorkflow`, currently swallowed by `createFileHandler`. Inspect submission response and unpublish on 400 to preserve parity. Impact: low (most uploads succeed; fallback job retries stalled scans).
- [ ] **`ModelFile.exists` tracking** — legacy flips `exists=false` when URL resolution fails. New flow doesn't set it. Decide whether downloads/search filters still rely on `exists` and, if so, drive it from `submitWorkflow` 400 responses.
- [x] **`model-hash-fix` notification (D3)** — synthesized in `applyScanOutcome` by comparing pre-existing `AutoV2` to new `AutoV2` (captured before hash deletion). Fires for both legacy and orchestrator paths.
- [ ] **`Convert` task** — legacy created sibling `ModelFile` rows for `safetensors↔ckpt` conversion. Confirmed dead code; safe to drop with the rest of the legacy webhook.
- [ ] **`Import` task** — legacy reassigned `ModelFile.url` after the scanner moved the file into the S3 bucket. With orchestrator we own the upload flow end-to-end; no equivalent needed unless something still depends on the post-scan URL rewrite.
- [x] **Cache strategy (D5)** — switched to `dataForModelsCache.refresh()` to match legacy's proactive re-warm.
- [ ] **HTTP status on missing file in webhook** — legacy returns 404 if `ModelFile` not found; new throws → 500. Cosmetic but worth aligning.

---

## Webhook Comparison: Legacy vs Orchestrator

**Bottom line**: the two endpoints can't be a single endpoint because the payload contracts are fundamentally different. But the *business logic* should be a single shared service that both adapters call.

| | Legacy `/api/webhooks/scan-result` | New `/api/webhooks/model-file-scan-result` |
|---|---|---|
| Caller | Legacy HTTP scanner | Orchestrator |
| Identifier | `?fileId=&tasks=...` querystring | `workflowId` in body, `fileId` in workflow `metadata` |
| Body | Full `ScanResult` payload (one task set per call) | `WorkflowEvent { workflowId, type, status }` only |
| Results retrieval | Inline in body | Round-trip via `getWorkflow()` to read step outputs |
| Granularity | Per-task gates (`tasks.includes('Scan')` etc.) | All 4 steps in one event |

### Behavior delta (legacy → new)

| # | Legacy behavior | New status | Action |
|---|-----------------|-----------|--------|
| 1 | `data.exists = scanResult.fileExists === 1`, `unpublish()` if missing (`scan-result.ts:73-77`, `:235-266`) | Not handled | 🟢 Worth considering — fold into `createFileHandler` 400-response path |
| 2 | Stores raw `ScanResult` in `ModelFile.rawScanResult` (`:51`) | ✅ Ported — normalized envelope `{ source, ... }` written by both adapters (D1) | — |
| 3 | Captures pre-existing SHA256 *before* hash deletion (`:100-107`, `:124`) | ✅ Ported — captures `AutoV2` for hash-fix detection (D3); SHA256 capture wired but commented (D2) | — |
| 4 | `isModelHashBlocked()` + `unpublishBlockedModel()` (`:126-128`, `:217-233`) — currently commented out | ✅ Carried forward as commented-out — matches legacy (D2) | — |
| 5 | `model-hash-fix` notification on `fixed: ['sshs_hash']` (`:179-199`) | ✅ Synthesized from `AutoV2` diff in `applyScanOutcome` (D3) | — |
| 6 | `dataForModelsCache.refresh(modelId)` (`:175`) | ✅ Switched from `bust()` to `refresh()` (D5) | — |
| 7 | Returns 404 on missing file (`:38-44`) | Logs warning, returns silently in `applyScanOutcome` | 🟢 Cosmetic |
| 8 | `examinePickleScanMessage` with `specialImports` check (`:319-360`) | ✅ Ported as `examinePickleImports` | — |
| 9 | Hash field map → `ModelFileHash` upsert (`:99-129`) | ✅ Ported | — |
| 10 | `headerData` JSON parse + `ss_tag_frequency` quirk (`:62-69`) | ✅ Ported | — |
| 11 | Search index queue update (`:163-176`) | ✅ Ported | — |
| 12 | `deleteFilesForModelVersionCache` (`:177`) | ✅ Ported | — |
| 13 | `ScanExitCode` → `ScanResultCode` mapping | ✅ Ported as `exitCodeToScanResult` | — |
| 14 | `Convert` task → sibling `ModelFile` creation (`:132-161`) | Not ported | 🟢 Confirm dead, then drop with legacy |
| 15 | `Import` task → URL rewrite (`:72-78`) | Not ported | 🟢 Confirm dead, then drop with legacy |

### Recommended target shape

```
src/server/services/model-file-scan-result.service.ts   ← shared logic
  ├─ applyScanOutcome({ fileId, virusScan, pickleScan, hashes, headerData, modelVersionId? })
  ├─ examinePickleImports(...)
  └─ (cache busting, search index queue, hash blocking, notifications)

src/pages/api/webhooks/scan-result.ts                   ← legacy adapter (DELETE in Phase 3)
  parses ScanResult → calls applyScanOutcome()

src/pages/api/webhooks/model-file-scan-result.ts        ← orchestrator adapter
  fetches workflow, maps step outputs → calls applyScanOutcome()
```

This makes the eventual deletion of the legacy webhook a delete-the-adapter operation, with zero risk of behavioral drift during the rollout.

---

## Architecture Diagram

### During rollout (flag-gated, both paths coexist)

```
User Upload
    |
    v
createFileHandler() --> ModelFile record (status: Pending)
    |
    +-- isFlipt(MODEL_FILE_SCAN_ORCHESTRATOR) ?
    |       |
    |  YES  |  NO
    |       |
    v       v
 [NEW]   [LEGACY]
 createModelFileScanRequest()    (no inline call - relies on cron)
    |                                       |
    v                                       v
 Orchestrator                       scanFilesJob (*/5 * * * *)
 (modelClamScan + modelPickleScan       early-return if flag ON
  + modelHash + modelParseMetadata)        |
    |                                       v
    v                               requestScannerTasks() -> SCANNING_ENDPOINT
 /webhooks/model-file-scan-result               |
 (getWorkflow -> step outputs)                  v
    |                               /webhooks/scan-result
    +---------+---------+                       |
    |         |         |                       |
    v         v         v                       v
   ----- applyScanOutcome() (shared service) -----
                      |
       +--------+-----+-----+--------+
       v        v           v        v
  virusScan pickleScan   hashes  headerData
   result    result      upsert   update

Fallback paths (every 5 min):
  scanFilesJob          → legacy scanner (flag OFF)
  scanFilesFallbackJob  → orchestrator    (flag ON)
```

### Target state (post-Phase-3 cleanup)

```
User Upload
    |
    v
createFileHandler() --> ModelFile record (status: Pending)
                               |
                               v
                   createModelFileScanRequest()
                               |
                               v
                   submitWorkflow() via @civitai/client
                   (modelClamScan + modelPickleScan + modelHash + modelParseMetadata)
                               |
                               v
                   Orchestrator Service
                               |
                               v
              /webhooks/model-file-scan-result
              (getWorkflow -> process step outputs)
                               |
                               v
                       applyScanOutcome()
                     |          |          |
                     v          v          v
               virusScan   pickleScan   hashes
               result      result       upsert

Fallback: scanFilesFallbackJob (*/5 * * * *) for stalled/missed files
```
