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
| `src/server/jobs/scan-files.ts` | **TODO** - Add fallback job for files that missed initial scan or stalled |

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

## Follow-up Work

### Required Cleanup (once new flow is validated)

1. **Remove legacy scanner integration**
   - Delete `/api/webhooks/scan-result` endpoint
   - Remove `scanFilesJob` and `requestScannerTasks()` from `scan-files.ts`
   - Remove `SCANNING_ENDPOINT` and `SCANNING_TOKEN` env vars

2. **Migrate remaining `requestScannerTasks()` callers to orchestrator**
   - `rescanModel()` in `src/server/services/model.service.ts:1129` — manual rescans
   - Admin cleanup endpoint in `src/pages/api/mod/clean-up.ts:47`

### Worth Considering

3. **Unpublish on missing file**
   - Legacy scanner unpublishes the version when `fileExists=false` is reported in the callback
   - New orchestrator signals a missing file via a 400 response on `submitWorkflow`
   - `createFileHandler` currently catches and swallows that error (fire-and-forget)
   - If we want to preserve unpublish behavior on missing files, we need to inspect the submission response and unpublish the version when it fails with 400
   - Impact: low — most uploads succeed, fallback job retries stalled scans

4. **Hash blocking re-enable**
   - Legacy `scan-result.ts:126-128` has commented-out code for blocking duplicate/malware hashes via `isModelHashBlocked()`
   - Not currently active, but listed as something to preserve
   - Decision needed: enable in new service, or leave disabled

5. **`ModelFile.exists` tracking**
   - Legacy job flips `exists: false` when a file URL can't be resolved
   - New flow doesn't set `exists` at all
   - If downloads/search filters rely on `exists`, they may stop getting updated accurately
   - Could be set based on workflow submission result (400 = file not found)

6. **Dev skip logic**
   - Legacy `requestScannerTasks()` fakes successful scans when `SCANNING_ENDPOINT` is unset
   - This keeps local dev from leaving files forever-`Pending`
   - New orchestrator path has no equivalent
   - If `ORCHESTRATOR_ACCESS_TOKEN` is missing or orchestrator unreachable, files will sit `Pending` forever in local dev
   - Mitigation: detect missing token in `createModelFileScanRequest()` and skip + mark as scanned

---

## Architecture Diagram

```
User Upload
    |
    v
createFileHandler() --> ModelFile record (status: Pending)
                               |
                               v
                   scanFilesJob (every 5 min)
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
                     |          |          |
                     v          v          v
               virusScan   pickleScan   hashes
               result      result       upsert
```
