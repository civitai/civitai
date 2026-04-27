import * as z from 'zod';
import { ModelHashType, ScanResultCode } from '~/shared/utils/prisma/enums';
import { ScannerTasks } from '~/server/jobs/scan-files';
import { logToAxiom } from '~/server/logging/client';
import {
  applyScanOutcome,
  examinePickleImports,
  type ScanOutcome,
} from '~/server/services/model-file-scan-result.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

// Legacy scanner adapter. The legacy HTTP scanner POSTs ScanResult here; we
// translate it into a normalized ScanOutcome and let applyScanOutcome() do the
// DB work. Phase 3 deletes this endpoint once MODEL_FILE_SCAN_ORCHESTRATOR has
// been at 100% for ≥1 week.
//
// Note: `Import` and `Convert` tasks are dropped from the adapter — confirmed
// dead by callsite audit (no caller passes them as `tasks=`). The unpublish-on-
// missing-file path tied to Import never fires in production today.

enum ScanExitCode {
  Pending = -1,
  Success = 0,
  Danger = 1,
  Error = 2,
}

const resultCodeMap: Record<ScanExitCode, ScanResultCode> = {
  [ScanExitCode.Pending]: ScanResultCode.Pending,
  [ScanExitCode.Success]: ScanResultCode.Success,
  [ScanExitCode.Danger]: ScanResultCode.Danger,
  [ScanExitCode.Error]: ScanResultCode.Error,
};

type ScanResult = {
  url: string;
  fileExists: number;
  picklescanExitCode: ScanExitCode;
  picklescanOutput?: string;
  picklescanGlobalImports?: string[];
  picklescanDangerousImports?: string[];
  clamscanExitCode: ScanExitCode;
  clamscanOutput: string;
  hashes: Record<ModelHashType, string>;
  metadata: MixedObject;
  conversions: Record<'safetensors' | 'ckpt', unknown>;
  fixed?: string[];
};

const querySchema = z.object({
  fileId: z.preprocess((val) => Number(val), z.number()),
  tasks: z
    .preprocess((val) => (Array.isArray(val) ? val : [val]), z.array(z.enum(ScannerTasks)))
    .optional(),
});

// Lower-cased lookup so legacy hash keys (e.g. `SHA256`, `AutoV2`) round-trip
// safely into ModelHashType regardless of payload casing.
const hashTypeMap: Record<string, ModelHashType> = {};
for (const t of Object.keys(ModelHashType)) {
  hashTypeMap[t.toLowerCase()] = ModelHashType[t as keyof typeof ModelHashType];
}

export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { fileId, ...query } = querySchema.parse(req.query);
  const tasks = query.tasks ?? ['Scan', 'Hash', 'ParseMetadata'];
  const scanResult: ScanResult = req.body;

  logToAxiom(
    {
      type: 'info',
      name: 'scan-result',
      message: `Received scan result for file ${fileId}`,
      fileId,
      tasks,
    },
    'webhooks'
  ).catch();

  try {
    const outcome: ScanOutcome = { fileId, rawScanResult: { source: 'legacy', ...scanResult } };

    if (tasks.includes('Scan')) {
      // Match the orchestrator adapter: only surface scanner output as a message
      // when the scan resolved to a non-success state (Danger/Error). For Pending
      // the output is typically empty/irrelevant and would confuse the UI.
      const clamFailed =
        scanResult.clamscanExitCode === ScanExitCode.Danger ||
        scanResult.clamscanExitCode === ScanExitCode.Error;
      outcome.virusScan = {
        result: resultCodeMap[scanResult.clamscanExitCode] ?? ScanResultCode.Pending,
        message: clamFailed ? scanResult.clamscanOutput : null,
      };

      const { pickleScanMessage, hasDanger } = examinePickleImports({
        exitCode: scanResult.picklescanExitCode,
        dangerousImports: scanResult.picklescanDangerousImports,
        globalImports: scanResult.picklescanGlobalImports,
      });
      outcome.pickleScan = {
        result: hasDanger
          ? ScanResultCode.Danger
          : resultCodeMap[scanResult.picklescanExitCode] ?? ScanResultCode.Pending,
        message: pickleScanMessage,
        dangerousImports: scanResult.picklescanDangerousImports,
      };
    }

    if (tasks.includes('Hash') && scanResult.hashes) {
      const hashes: Partial<Record<ModelHashType, string>> = {};
      for (const [key, value] of Object.entries(scanResult.hashes)) {
        const type = hashTypeMap[key.toLowerCase()];
        if (type && typeof value === 'string' && value) hashes[type] = value;
      }
      if (Object.keys(hashes).length > 0) outcome.hashes = hashes;
    }

    if (tasks.includes('ParseMetadata') && scanResult.metadata?.__metadata__) {
      const headerData = scanResult.metadata.__metadata__ as MixedObject;
      if (typeof headerData?.ss_tag_frequency === 'string') {
        try {
          headerData.ss_tag_frequency = JSON.parse(headerData.ss_tag_frequency);
        } catch {
          // leave as string if inner parse fails
        }
      }
      outcome.headerData = headerData;
    }

    await applyScanOutcome(outcome);

    logToAxiom(
      {
        type: 'info',
        name: 'scan-result',
        message: `Completed scan result processing for file ${fileId}`,
        fileId,
      },
      'webhooks'
    ).catch();

    return res.status(200).json({ ok: true });
  } catch (error) {
    // Mirrors the orchestrator webhook so failures from both paths are visible
    // under the same Axiom query shape during canary skew comparison.
    logToAxiom(
      {
        type: 'error',
        name: 'scan-result',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        fileId,
      },
      'webhooks'
    ).catch();
    return res.status(500).json({ error: 'Internal server error' });
  }
});
