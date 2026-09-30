import type { Context } from '~/server/createContext';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

/**
 * Gates buying a promotion and the host's promotion settings. Checked on the
 * mutation, not only where the button is drawn. Deliberately not applied to a
 * host answering what is already waiting on them, so turning the flag off never
 * strands held Buzz with no way to decline it.
 */
export function assertPromotionsEnabled(ctx: Pick<Context, 'features'>) {
  if (!ctx.features.creatorPromotions)
    throw throwAuthorizationError('promotion: this is not available yet');
}
