import { registerCounterWithLabels } from '~/server/prom/client';

/** App Blocks entries: their sources must be scanned, unflagged images stored on Civitai. */
export const APP_BLOCK_ENTRY_LIST = [
  'appBlocks',
  'appBlocksStep',
  'appBlocksPassThrough',
  'appBlocksWorkflow',
  'appBlocksInlineComfy',
  /**
   * Not a generation: `blocks.persistGenerationSource` asking whether the private source it just
   * wrote is usable yet, so its pending polls count apart from real refusals.
   */
  'appBlocksSourcePersist',
] as const;

export const APP_BLOCK_HOST_SOURCE_REASONS = [
  'host-orchestrator-source',
  'host-unparsable',
] as const;

/** The classes the source gate can accept; every other class is refused. */
export const APP_BLOCK_ACCEPTED_SOURCE_CLASSES = [
  'cdn',
  'key',
  'orchestrator',
  'external',
] as const;

export const APP_BLOCK_SOURCE_FLAGS = ['source-scanned-rows', 'refuse-external-sources'] as const;
export type AppBlockSourceFlag = (typeof APP_BLOCK_SOURCE_FLAGS)[number];

/** App Blocks source flag reads that could not be evaluated and so answered ON (refuse). */
export const appBlockSourceFlagUnknownCounter = registerCounterWithLabels({
  name: 'app_block_source_flag_unknown_total',
  help: 'App Blocks source flag reads that could not be evaluated and answered on, by flag.',
  labelNames: ['flag'] as const,
});

/**
 * Orchestrator sources on App Blocks entries, counted only: nothing is refused on this count.
 * `host-orchestrator-source` is a consumer-blob path; `host-unparsable` is any other orchestrator
 * path, such as a job output.
 */
export const appBlockHostSourceCounter = registerCounterWithLabels({
  name: 'app_block_host_source_total',
  help: 'Orchestrator-hosted generation sources on App Blocks entries, by entry point and reason.',
  labelNames: ['entry', 'reason'] as const,
});

/**
 * Sources the gate accepted on App Blocks entries, one per distinct source of a call that passed;
 * a refused call counts nothing.
 */
export const appBlockSourceAcceptedCounter = registerCounterWithLabels({
  name: 'app_block_source_accepted_total',
  help: 'Generation sources the App Blocks source gate accepted, by entry point and url class.',
  labelNames: ['entry', 'class'] as const,
});

/**
 * Publishes both counters at 0 for every label pair, so a series that never fired reads as 0
 * rather than absent. Idempotent.
 */
export function seedAppBlockSourceMetrics(): void {
  try {
    for (const flag of APP_BLOCK_SOURCE_FLAGS) appBlockSourceFlagUnknownCounter.inc({ flag }, 0);
    for (const entry of APP_BLOCK_ENTRY_LIST) {
      for (const reason of APP_BLOCK_HOST_SOURCE_REASONS)
        appBlockHostSourceCounter.inc({ entry, reason }, 0);
      for (const cls of APP_BLOCK_ACCEPTED_SOURCE_CLASSES)
        appBlockSourceAcceptedCounter.inc({ entry, class: cls }, 0);
    }
  } catch {
    // Seeding is a readability nicety; losing it must not cost the scrape.
  }
}
