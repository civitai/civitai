import type { Context } from '~/server/createContext';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

/**
 * Gates every promotion procedure and the promotion surfaces of the shared
 * placement endpoints. With the flag off a pending promotion cannot be answered,
 * so it expires and the buyer is refunded by the placement expiry sweep.
 */
export function assertPromotionsEnabled(ctx: Pick<Context, 'features'>) {
  if (!ctx.features.creatorPromotions)
    throw throwAuthorizationError('promotion: this is not available yet');
}
