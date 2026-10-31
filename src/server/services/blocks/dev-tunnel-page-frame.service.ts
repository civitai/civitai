import { isAppBlocksDevTunnelEnabled } from '~/server/services/app-blocks-flag';
import type { DevTunnelFrame } from '~/server/services/blocks/dev-tunnel-frame.service';
import { resolveDevTunnelFrame } from '~/server/services/blocks/dev-tunnel-frame.service';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

/**
 * The `/apps/dev/<blockId>` gates, shared by the page and `/api/apps/dev/entry-url`: App Blocks,
 * the author capability, the dev-tunnel kill switch, then ownership. Every refusal is the same
 * `null`. The caller requires the session.
 */
export async function resolveDevTunnelPageFrame(
  user: SessionUser,
  blockId: string,
  features: Partial<Pick<FeatureAccess, 'appBlocks' | 'appBlocksAuthor'>> | undefined
): Promise<DevTunnelFrame | null> {
  if (!features?.appBlocks || !features?.appBlocksAuthor) return null;
  if (!(await isAppBlocksDevTunnelEnabled({ user }))) return null;
  if (!blockId) return null;
  return resolveDevTunnelFrame(user, blockId);
}
