import { isAppBlocksDevTunnelEnabled } from '~/server/services/app-blocks-flag';
import type { DevTunnelFrame } from '~/server/services/blocks/dev-tunnel-frame.service';
import { resolveDevTunnelFrame } from '~/server/services/blocks/dev-tunnel-frame.service';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

/**
 * The `/apps/dev/<blockId>` gates, in the one place both of its entry points read them:
 *   - the page's `getServerSideProps` (`src/pages/apps/dev/[blockId].tsx`);
 *   - its Retry's fresh-URL endpoint (`src/pages/api/apps/dev/entry-url.ts`).
 *
 * In order: the App Blocks flag and the author capability, the `app-blocks-dev-tunnel` kill switch,
 * then ownership (`resolveDevTunnelFrame` → `resolveDevPageBlockForAuthor`). Every refusal is the
 * same `null`, so a foreign, missing or gated app cannot be told apart. The signed-in session is the
 * caller's to require first.
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
