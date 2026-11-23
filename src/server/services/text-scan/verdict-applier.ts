import { logToAxiom } from '~/server/logging/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';

type ApplyTextScanArgs = Parameters<NonNullable<ModerationAdapter['applyTextScan']>>[0];
type VerdictApplier = (entityType: string, args: ApplyTextScanArgs) => Promise<void>;

let applier: VerdictApplier | null = null;

/**
 * The adapter registry (`moderation-adapters.ts`) sets this when it loads, and the server loads it at
 * start (`instrumentation.ts`). Text scan applies a verdict through it instead of importing the
 * registry, which imports every entity service and would put text scan in their import cycle.
 */
export function setTextScanVerdictApplier(next: VerdictApplier) {
  applier = next;
}

/** Applies a text-scan verdict through the entity's moderation adapter. */
export async function applyTextScanVerdict(entityType: string, args: ApplyTextScanArgs) {
  if (!applier) {
    logToAxiom({
      name: 'text-scan',
      type: 'error',
      message: 'verdict applier not registered',
      entityType,
      entityId: args.entityId,
    });
    return;
  }
  await applier(entityType, args);
}
