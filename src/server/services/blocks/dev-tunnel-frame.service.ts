import { env } from '~/env/server';
import { isAppBlocksDevTunnelUnsubmittedSpendEnabled } from '~/server/services/app-blocks-flag';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { getActiveDevTunnel } from '~/server/services/blocks/dev-tunnel.service';
import {
  isValidDevHost,
  signDevTunnelAccessToken,
} from '~/server/services/blocks/dev-tunnel-session';
import type { SessionUser } from '~/types/session';

/** What a page needs to mount the caller's own app over its live dev tunnel. */
export interface DevTunnelFrame {
  appBlockId: string;
  blockId: string;
  appId: string;
  appName: string;
  pageTitle: string;
  status: string;
  trustTier: 'unverified' | 'verified' | 'internal';
  sandbox: string;
  scopes: string[];
  bootSkeleton: boolean;
  /** `https://<dev-host>/?dev=<entry token>`, set only while a tunnel with a valid host is active. */
  iframeSrc: string | null;
  host: string | null;
}

/**
 * Resolves the caller's OWN app (any status, or an unclaimed slug) and, when its dev tunnel is
 * live, a freshly signed entry URL. `null` for an app the caller does not own — the same answer as
 * one that does not exist. The host comes only from the server-side tunnel record, never from input.
 *
 * Callers gate on the author capability and the dev-tunnel flag first.
 */
export async function resolveDevTunnelFrame(
  user: SessionUser,
  blockId: string
): Promise<DevTunnelFrame | null> {
  // The tunnel comes first: a brand-new app's scopes are the ones its session declared.
  const tunnel = await getActiveDevTunnel(user.id, blockId);
  const unsubmittedSpendAllowed = await isAppBlocksDevTunnelUnsubmittedSpendEnabled({ user });
  const app = await BlockRegistry.resolveDevPageBlockForAuthor(blockId, user.id, {
    sessionGrantedScopes: tunnel?.grantedScopes,
    unsubmittedSpendAllowed,
  });
  if (!app) return null;

  let iframeSrc: string | null = null;
  let host: string | null = null;
  if (tunnel && isValidDevHost(tunnel.host, env.APPS_DOMAIN)) {
    host = tunnel.host;
    const token = signDevTunnelAccessToken({ userId: user.id, host });
    iframeSrc = `https://${host}/?dev=${encodeURIComponent(token)}`;
  }

  return {
    appBlockId: app.appBlockId,
    blockId: app.blockId,
    appId: app.appId,
    appName: app.name,
    pageTitle: app.pageTitle,
    status: app.status,
    trustTier: app.trustTier,
    sandbox: app.sandbox,
    scopes: app.scopes,
    bootSkeleton: app.bootSkeleton,
    iframeSrc,
    host,
  };
}
