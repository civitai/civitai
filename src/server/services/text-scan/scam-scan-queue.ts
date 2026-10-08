import pLimit from 'p-limit';
import { logToAxiom } from '~/server/logging/client';
import type { TextScanEntityType } from '~/server/services/text-scan/types';

type ScanArgs = { entityType: TextScanEntityType; entityId: number };

// Loaded on first use: hub services (user, comment) import this module, and a static edge would hand
// every one of their importers the whole text-scan graph and a cycle risk through it.
const scanEntity = async (args: ScanArgs) =>
  (await import('~/server/services/text-scan/submit')).scanEntity(args);

export function createScamScanQueue({
  concurrency,
  maxPending,
  scan = scanEntity,
}: {
  concurrency: number;
  maxPending: number;
  scan?: (args: ScanArgs) => Promise<unknown>;
}) {
  const limit = pLimit(concurrency);
  return (args: ScanArgs) => {
    // A dropped scan leaves no EntityModeration row, so nothing retries it; this log is the signal.
    if (limit.pendingCount >= maxPending) {
      void logToAxiom({
        name: 'text-scan',
        type: 'warning',
        message: 'scam scan queue full, dropped',
        ...args,
      }).catch(() => undefined);
      return;
    }
    void limit(() => scan(args)).catch((error) =>
      logToAxiom({
        name: 'text-scan',
        type: 'error',
        message: 'background scan threw',
        ...args,
        error: (error as Error).message,
      }).catch(() => undefined)
    );
  };
}

export const queueScamScan = createScamScanQueue({ concurrency: 8, maxPending: 2000 });
