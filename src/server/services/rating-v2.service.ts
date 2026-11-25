import type { WorkflowStepTemplate } from '@civitai/orchestration-client';
import { submitWorkflow } from '@civitai/orchestration-client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { isCivitaiMediaUrl } from '~/server/services/orchestrator/trusted-blob-url';
import { toOrchestratorError } from '~/server/services/training.service';

// On the system token: a scan submitted with the user's own token is charged to them.

/** The rater the scanner runs when an imageScanning step names it in `rater-model`. */
export const RATER_V2 = 'radio-alpha';
const IMAGE_PATH = /\.(png|jpe?g|webp|gif|bmp)$/i;
const SEXUAL_LEVEL = /^s([0-4])$/i;

/** An image the orchestrator hosts: the only media sent to the rater. */
export function isRateableMediaUrl(raw: string): boolean {
  return isCivitaiMediaUrl(raw) && IMAGE_PATH.test(new URL(raw).pathname);
}

/** A mature-level flag variant (s1-s4) as its level; anything else is off. */
export function matureLevelOf(variant: unknown): number | null {
  const match = typeof variant === 'string' ? /^s([1-4])$/i.exec(variant.trim()) : null;
  return match ? Number(match[1]) : null;
}

/** Mature or not at `matureLevel`, or null when the output has no v2 rating to trust. */
function matureVerdict(output: unknown, matureLevel: number): boolean | null {
  const block = (output as { ratingV2?: unknown } | null | undefined)?.ratingV2 as
    | { status?: unknown; sexual?: { label?: unknown }; restricted?: unknown }
    | null
    | undefined;
  if (!block || typeof block !== 'object' || block.status !== 'ok') return null;
  const label = block.sexual?.label;
  const match = typeof label === 'string' ? SEXUAL_LEVEL.exec(label) : null;
  if (!match || typeof block.restricted !== 'boolean') return null;
  return block.restricted || Number(match[1]) >= matureLevel;
}

/** One imageScanning step per item on the v2 rater, in one workflow: each item's mature verdict, null
 *  when its step did not succeed within `waitSeconds` or gave no v2 rating. */
export async function rateImagesV2({
  items,
  matureLevel,
  metadata,
  tags,
  waitSeconds,
}: {
  items: { key: string; mediaUrl: string }[];
  matureLevel: number;
  metadata: Record<string, unknown>;
  tags: string[];
  waitSeconds: number;
}): Promise<{ key: string; mature: boolean | null }[]> {
  const steps = items.map(
    (item, i) =>
      ({
        $type: 'imageScanning',
        name: `${i}`,
        metadata: { ...metadata, key: item.key },
        // `rater-model` is not in the client's ImageScanningInput type yet.
        input: { image: item.mediaUrl, 'rater-model': RATER_V2 },
      } as unknown as WorkflowStepTemplate)
  );
  const { data, error } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: waitSeconds },
    body: { tags, metadata, steps, currencies: [] },
  });
  if (!data) toOrchestratorError(error);
  const byName = new Map((data.steps ?? []).map((s) => [s.name, s]));
  return items.map((item, i) => {
    const step = byName.get(`${i}`) as { status?: string; output?: unknown } | undefined;
    return {
      key: item.key,
      mature: step?.status === 'succeeded' ? matureVerdict(step.output, matureLevel) : null,
    };
  });
}
