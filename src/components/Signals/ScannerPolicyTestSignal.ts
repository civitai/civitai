import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import type { ScannerPolicyTestProgressData } from '~/server/schema/scanner-policies.schema';

/**
 * Page-scoped subscription to the scanner-policy test-run progress signal.
 *
 * Only the /moderator/scanner-policies page imports this module, so the
 * listener attaches on mount and detaches on unmount — that's the lazy gate.
 * No SignalsRegistrar wiring needed.
 *
 * Filter by `runId` client-side if a mod kicks off multiple runs in parallel
 * tabs.
 */
export function useScannerPolicyTestSignal(
  onUpdate: (data: ScannerPolicyTestProgressData) => void
) {
  useSignalConnection(
    SignalMessages.ScannerPolicyTestProgress,
    useCallback(
      (data: ScannerPolicyTestProgressData) => {
        onUpdate(data);
      },
      [onUpdate]
    )
  );
}
