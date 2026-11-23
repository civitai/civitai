import { logToAxiom } from '~/server/logging/client';
import type { ModerationAdapter } from '~/server/services/entity-moderation.service';

type ApplyTextScanArgs = Parameters<NonNullable<ModerationAdapter['applyTextScan']>>[0];
type VerdictApplier = (entityType: string, args: ApplyTextScanArgs) => Promise<void>;

declare global {
  // eslint-disable-next-line no-var
  var __civitaiTextScanVerdictApplier: VerdictApplier | undefined;
}

/**
 * The adapter registry (`moderation-adapters.ts`) sets this when it loads, and the server loads it at
 * start (`instrumentation.ts`). Text scan applies a verdict through it instead of importing the
 * registry, which imports every entity service and would put text scan in their import cycle.
 *
 * On `globalThis`, not a module-scope variable: the build emits this module many times, and a setter
 * called from instrumentation reaches only its own copy (`logging/structured-log-sink.ts` measured it).
 */
export function setTextScanVerdictApplier(next: VerdictApplier) {
  globalThis.__civitaiTextScanVerdictApplier = next;
}

/** Applies a text-scan verdict through the entity's moderation adapter. */
export async function applyTextScanVerdict(entityType: string, args: ApplyTextScanArgs) {
  const applier = globalThis.__civitaiTextScanVerdictApplier;
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
