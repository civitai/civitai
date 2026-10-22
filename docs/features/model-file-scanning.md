# Model File Scanning

## Overview

When users upload model files to a model version, the system scans them for viruses, dangerous pickle imports, and computes file hashes. Scans run as orchestrator workflows via `@civitai/orchestration-client`.

## How It Works

### Scan Types

A single workflow submits four orchestrator step types per file:

| Step Type         | `$type`              | Input                     | Output                                                            |
| ----------------- | -------------------- | ------------------------- | ----------------------------------------------------------------- |
| ClamAV Virus Scan | `modelClamScan`      | `{ model: string }` (AIR) | `{ exitCode, output }`                                            |
| Pickle Scan       | `modelPickleScan`    | `{ model: string }` (AIR) | `{ exitCode, output, globalImports, dangerousImports }`           |
| File Hashing      | `modelHash`          | `{ model: string }` (AIR) | `{ shA256, autoV1, autoV2, autoV3, blake3, crC32 }`               |
| Parse Metadata    | `modelParseMetadata` | `{ model: string }` (AIR) | `{ metadata: string \| null }` (raw JSON header from safetensors) |

All steps take a `model` AIR string as input (e.g. `urn:air:sd1:checkpoint:civitai:12345@67890`).

### Workflow Submission

Submit a single workflow with all four steps using `submitWorkflow` from `@civitai/orchestration-client` and the `internalOrchestratorClient`:

```typescript
import { submitWorkflow } from '@civitai/orchestration-client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';

const { data, error } = await submitWorkflow({
  client: internalOrchestratorClient,
  body: {
    metadata: { fileId, modelVersionId },
    currencies: [],
    tags: ['civitai', 'model-scan'],
    steps: [
      { $type: 'modelClamScan', name: 'clamScan', metadata: { fileId }, input: { model: air } },
      { $type: 'modelPickleScan', name: 'pickleScan', metadata: { fileId }, input: { model: air } },
      { $type: 'modelHash', name: 'hash', metadata: { fileId }, input: { model: air } },
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

The orchestrator calls back to `/api/webhooks/model-file-scan-result`:

1. Receive `WorkflowEvent` in request body
2. Fetch the full workflow via `getWorkflow({ client: internalOrchestratorClient, path: { workflowId } })`
3. Extract `fileId` from `data.metadata`
4. Process each step's output by `$type`:
   - `modelClamScan` → update `virusScanResult`, `virusScanMessage`
   - `modelPickleScan` → update `pickleScanResult`, `pickleScanMessage` (examine dangerous imports)
   - `modelHash` → upsert `ModelFileHash` records
   - `modelParseMetadata` → parse JSON string and store in `ModelFile.headerData`
5. On failure (`event.status !== 'succeeded'`), mark file for retry

```
POST /api/webhooks/model-file-scan-result?token=<WEBHOOK_TOKEN>
Body: WorkflowEvent { workflowId, type, status }
```

### Key Implementation Files

| File                                                       | Purpose                                                                                                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/services/orchestrator/orchestrator.service.ts` | `createModelFileScanRequest()` and `ModelFileScanSubmissionError`. Pre-flight URL resolution with 60s sync-lag retry; throws `'not-found'` vs `'transient'` on submission failure   |
| `src/server/services/model-file-scan.service.ts`           | Shared `applyScanOutcome()`, `examinePickleImports()`, `processModelFileScanResult()` (orchestrator-side adapter), `rescanModel()`, `unpublishBlockedModel()`. A failed scan busts the version AIRs (once per version per hour) and the scan's file-pinned AIR (once per file per hour) |
| `src/pages/api/webhooks/model-file-scan-result.ts`         | Thin webhook adapter for orchestrator callbacks                                                                                                                                     |
| `src/server/controllers/model-file.controller.ts`          | Inline `createModelFileScanRequest()` on file create with `preflight: false` (fallback job tombstones if file is missing)                                                           |
| `src/server/jobs/scan-files.ts`                            | `scanFilesFallbackJob` (cron `*/5 * * * *`) — resubmits stalled/pending files via orchestrator; tombstones permanent `'not-found'`s, resets `scanRequestedAt` on transient failures |
| `src/pages/api/webhooks/run-jobs/[[...run]].ts`            | Registers `scanFilesFallbackJob`                                                                                                                                                    |
| `src/pages/api/mod/clean-up.ts`                            | Admin endpoint; submits the full orchestrator workflow per file                                                                                                                     |
| `src/server/jobs/retroactive-hash-blocking.ts`             | Imports `unpublishBlockedModel` from `model-file-scan.service.ts`                                                                                                                   |
| `src/pages/api/testing/model-file-scan.ts`                 | Manual scan-tester for ad-hoc verification                                                                                                                                          |

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

Local types for the step outputs (same pattern as `image-scan-result.service.ts`):

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

type ModelScanStep =
  | ModelClamScanStep
  | ModelPickleScanStep
  | ModelHashStep
  | ModelParseMetadataStep;
```

### Result Processing

Map orchestrator exit codes to `ScanResultCode`:

```typescript
// exitCode: 0 = Success, 1 = Danger, 2 = Error, null/-1 = Pending
const exitCodeToScanResult = (exitCode: number | null | undefined): ScanResultCode => {
  switch (exitCode) {
    case 0:
      return ScanResultCode.Success;
    case 1:
      return ScanResultCode.Danger;
    case 2:
      return ScanResultCode.Error;
    default:
      return ScanResultCode.Pending;
  }
};
```

Hash output maps to `ModelFileHash` records:

| Output Field | `ModelHashType` |
| ------------ | --------------- |
| `shA256`     | `SHA256`        |
| `autoV1`     | `AutoV1`        |
| `autoV2`     | `AutoV2`        |
| `autoV3`     | `AutoV3`        |
| `blake3`     | `BLAKE3`        |
| `crC32`      | `CRC32`         |

### Submission-Failure Policy

`createModelFileScanRequest` throws `ModelFileScanSubmissionError` on failure with one of two codes:

- `'not-found'` — pre-flight URL resolution failed twice (with a 60s sync-lag retry between attempts). The file is genuinely gone.
- `'transient'` — any other submission failure (orchestrator outage, network blip, etc.)

Caller policy is asymmetric on purpose:

| Caller                                       | Pre-flight?   | On `'not-found'`                                                            |
| -------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| `scanFilesFallbackJob` (cron)                | yes (default) | `exists = false` (tombstone, exits scan poll forever)                       |
| `rescanModel` (admin)                        | yes (default) | `exists = false`                                                            |
| `clean-up.ts` (admin)                        | yes (default) | `exists = false`                                                            |
| `createFileHandler` (inline post-upload)     | **no**        | log-only — file just landed; fallback job runs full pre-flight 5 min later  |
| `testing/model-file-scan.ts` (canary tester) | yes           | catch + report, **no DB write** — manual runs must not tombstone real files |

The fallback job uses `{ OR: [{ exists: null }, { exists: true }] }` in its WHERE clause, so tombstoned files exit the scan poll permanently.

On `'transient'`, the fallback job resets `scanRequestedAt = null` so the next 5-min tick retries, vs. waiting for the 24h workflow-failure backoff path.

### Admin Clean-Up Behavior

`/api/mod/clean-up.ts` submits the **full** orchestrator workflow (clam + pickle + hash + metadata) per file. This is intentional — the orchestrator workflow is atomic and the operational complexity of supporting partial-step submission isn't justified for an admin endpoint. Implications:

- Re-running clean-up on an already-scanned file re-evaluates virus/pickle results
- During processing, `virusScanResult` / `pickleScanResult` may transition through Pending before settling
- If the file's content hasn't changed, results should land the same; differences indicate scanner-rule changes (which is what you'd want to know about anyway)

Its submissions share the scanner pool with new uploads, so each call is bounded:

- Files named by `modelFileIds`, `modelVersionIds` or `modelIds` are re-scanned whatever their state.
- Bulk selection (`after`, or `all` alone) takes what the fallback job would: `virusScanResult` still `Pending`, not tombstoned (`exists` null or true), and not submitted in the last day (`scanRequestedAt` null or older than 1 day). A file is stamped only once its own submit succeeds, so files still queued inside a running call are not yet marked: the fallback job or a repeat call can submit them too. Pass `force=true` to lift all three.
- At most 500 files per call, in id order. A capped response carries `capped: true` and `nextAfterId`; pass that back as `afterId` for the next page. Page with `wait=false`: a `wait=true` call holds the response until all 500 submissions finish, which can outlast a proxy timeout and lose the cursor. Each call runs its own 5-way loop, so fetch the next page only once the previous one has drained.
- Submissions run 5 at a time.
- `all=true` with no other filter selects every non-Training-Data file, under the bulk rules above.

The legacy HTTP scanner accepted per-task gating (`['Hash', 'ParseMetadata']` only); the orchestrator does not. If a metadata-only refresh path is ever needed, it would require extending `createModelFileScanRequest` with optional step selection.

### Hash Blocking

`isModelHashBlocked()` framework is wired in `applyScanOutcome` (with pre-existing SHA256 capture in place) but the actual block + `unpublishBlockedModel()` call is **commented out**. This matches the pre-migration legacy behavior. Re-enabling is a separate product decision.

---

## Architecture

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
                   submitWorkflow() via @civitai/orchestration-client
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
                     |          |          |          |
                     v          v          v          v
               virusScan   pickleScan   hashes   headerData

Fallback: scanFilesFallbackJob (*/5 * * * *) for stalled/missed files
```

---

## Migration History

This feature replaced a legacy HTTP scanner (`SCANNING_ENDPOINT` / `SCANNING_TOKEN`, `/api/webhooks/scan-result`, `scanFilesJob`, `requestScannerTasks`). The migration ran in three phases gated by the Flipt flag `MODEL_FILE_SCAN_ORCHESTRATOR`:

1. **Phase 1** — Parity & gating: shared `applyScanOutcome()` extracted so both adapters used the same business logic; flag-gated dispatch sites.
2. **Phase 2** — Canary: flag rolled 1% → 10% → 50% → 100% with Axiom log comparisons (`name: scan-result` vs `name: model-file-scan-result`).
3. **Phase 3** — Cleanup: legacy scanner, webhook, flag, and env vars removed. Cron job key `scan-files-fallback` was retained for operational continuity with the pre-deprecation cron registry.

### Tasks Disposition

The legacy scanner supported 5 task types:

| Legacy Task     | Disposition                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `Scan`          | Replaced by `modelClamScan` + `modelPickleScan` steps                                             |
| `Hash`          | Replaced by `modelHash` step (now returns more hash types: blake3, crc32, autoV3)                 |
| `ParseMetadata` | Replaced by `modelParseMetadata` step                                                             |
| `Import`        | Dropped — confirmed dead by callsite audit (no caller passed it)                                  |
| `Convert`       | Dropped — confirmed dead by callsite audit (pickle-to-safetensors conversion was never requested) |

### Decisions

- **D1**: `rawScanResult` populated with a normalized envelope `{ source: 'orchestrator', ... }`. No schema migration.
- **D2**: The legacy blocklist check (hash matches a model unpublished for a violation) stays off. It is superseded by the cross-owner duplicate check below.
- **D3**: `model-hash-fix` notification synthesized from `AutoV2` diff in `applyScanOutcome` (orchestrator doesn't expose legacy's `fixed[]` array).
- **D4**: `applyScanOutcome` bumps `scanRequestedAt = now()` when `outcome.failed === true`, so the file retries via the 24h-stale path. Prevents tight retry loops on permanently broken AIRs.
- **D5**: Switched from `dataForModelsCache.bust()` to `.refresh()` for proactive re-warm.

### Duplicate Model Files

When a primary weights file (any of `primaryModelFileTypes`, at least 1 MB) gets its SHA256, `applyScanOutcome`
looks for a primary weights file with the same SHA256 on another creator's public, published model, uploaded
before the uploader's own first file with those bytes
(`src/server/services/duplicate-model-hash.service.ts`). On a match the model is unpublished with reason
`duplicate` and a message linking the original. Publishing runs the same lookup and refuses a match, for
files hashed before the original went live. The same owner re-uploading their own file, CivitaiOfficial
uploads, and moderators publishing (to restore a false positive) are exempt. A rescan of unchanged bytes
does not re-trigger it.

Two kinds of match are logged and never acted on:

- **Shared file:** the bytes are held by `DUPLICATE_HASH_SHARED_OWNER_THRESHOLD` or more owners (counting
  owners with a live copy, plus the uploader). That is a commonly re-hosted base or merged checkpoint, not one
  creator's work.
- **Original in doubt:** an earlier holder of the bytes is not the chosen original, because that holder's copy
  is unpublished or deleted. The chosen original may itself be a copy, so this is logged as review-needed.

Both halves sit behind the `duplicate-model-hash-block` Flipt flag, default off. While it is off nothing is
blocked. Every match is logged to Axiom with `name: 'duplicate-model-hash'` and `message` one of
`would-block` (flag off), `unpublished` / `blocked` (flag on), `exempt` or `review-needed`. Each event carries
`decision`, `reason`, `modelId`, `sha256`, `ownerCount`, the chosen original (`originalModelId`,
`originalFileId`), the earliest holder's file, and `flagEnabled`.

### Known Gap (Matches Legacy)

Pre-flight URL resolution catches files missing from storage-resolver / delivery-worker. It does **not** catch files present in storage but unfetchable by orchestrator (auth, race, B2 hiccup). Those surface as workflow-step failures → `applyScanOutcome({ failed: true })` → 24h `scanRequestedAt` backoff → fallback retry; if the issue is permanent the file stays `Pending` indefinitely. Legacy had the same gap. If Axiom shows files stuck `Pending` >7 days with repeated failed callbacks, follow-up options: failure-count counter + tombstone after N, stale-Pending sweeper job, or revisit with the orchestrator team.

### Auto-Unpublish on Missing File

Legacy `unpublish()` was called only when `tasks.includes('Import')`, but `Import` was never passed in production, so the auto-unpublish never actually fired. Not ported. Tombstoning via `exists = false` already exits the scan retry loop — the load-bearing piece. Auto-unpublishing creator content based on a single file-resolution failure has non-trivial false-positive risk (storage-resolver hiccup → unpublishing real models); revisit as a deliberate product decision if Axiom data later shows it's needed.
