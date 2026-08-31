import { capMediaType, feeToRatio } from '@civitai/buzz';
import { numberWithCommas } from '~/utils/number-helpers';

/**
 * `licensingFee` is stored per generation and is routinely fractional — 0.1 is the Free tier's cap for
 * every non-Checkpoint model type — so rendering it directly produces "0.1 / image". Creators set the fee
 * as a whole-number ratio, and both the upsert form and Creator Studio show it that way; this keeps the
 * public model page consistent with what the creator actually chose.
 */
export function formatLicensingFee(perGeneration: number, baseModel?: string | null): string {
  const { buzz, images } = feeToRatio(perGeneration);
  const noun = capMediaType(baseModel) === 'video' ? 'video' : 'image';
  return `${numberWithCommas(buzz)} / ${images} ${noun}${images === 1 ? '' : 's'}`;
}
