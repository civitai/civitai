import { isAppBlocksDevTunnelUnsubmittedSpendEnabled } from '~/server/services/app-blocks-flag';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { getActiveDevTunnel } from '~/server/services/blocks/dev-tunnel.service';
import { isDevTunnelHostPublished } from '~/server/services/blocks/dev-tunnel-dns.service';
import {
  isValidSessionHost,
  sessionHostDomains,
  signDevTunnelAccessToken,
} from '~/server/services/blocks/dev-tunnel-session';
import type { SessionUser } from '~/types/session';

/** What a page needs to mount the caller's own app over its live dev tunnel. */
export interface DevTunnelFrame {
  appBlockId: string;
  blockId: string;
  appId: string;
  appName: string;
  trustTier: 'unverified' | 'verified' | 'internal';
  sandbox: string;
  scopes: string[];
  bootSkeleton: boolean;
  /**
   * `https://<dev-host>/?dev=<entry token>`, set only while a tunnel with a valid host is active
   * and that host's DNS record is published.
   */
  iframeSrc: string | null;
  host: string | null;
  /** The tunnel is live but its host's DNS record is not published yet; `iframeSrc` is withheld. */
  dnsPending: boolean;
  /**
   * `"direct"` when the session is an App Assistant direct preview: `iframeSrc` is then
   * `https://<session host>/`, whose host is itself the credential (no entry token, no DNS wait).
   * Absent for a tunnel.
   */
  transport?: 'direct';
}

/**
 * Resolves the caller's OWN app (any status, or an unclaimed slug) and, when its dev tunnel is
 * live, a freshly signed entry URL. `null` for an app the caller does not own — the same answer as
 * one that does not exist. The host comes only from the server-side tunnel record, never from input.
 * It signs without checking the dev-tunnel kill switch, so callers must gate on it first.
 */
export async function resolveDevTunnelFrame(
  user: SessionUser,
  blockId: string
): Promise<DevTunnelFrame | null> {
  // The session's scopes feed the resolver, so a brand-new app's declaredScopes match what the
  // block-token mint (api/v1/block-tokens) will grant.
  const tunnel = await getActiveDevTunnel(user.id, blockId);
  const unsubmittedSpendAllowed = await isAppBlocksDevTunnelUnsubmittedSpendEnabled({ user });
  const app = await BlockRegistry.resolveDevPageBlockForAuthor(blockId, user.id, {
    sessionGrantedScopes: tunnel?.grantedScopes,
    unsubmittedSpendAllowed,
  });
  if (!app) return null;

  let iframeSrc: string | null = null;
  let host: string | null = null;
  let dnsPending = false;
  const direct = tunnel?.transport === 'direct';
  if (tunnel && isValidSessionHost(tunnel, sessionHostDomains())) {
    host = tunnel.host;
    // A direct preview's session host is itself the credential, minted once per session, so
    // every render returns the same origin; it has no record of its own to wait for.
    if (direct) iframeSrc = `https://${host}/`;
    else dnsPending = !(await isDevTunnelHostPublished(host));
    if (!direct && !dnsPending) {
      // A fresh short-TTL, author-bound entry token on every render, so the live iframe never
      // serves a stale one; the apps-domain edge verifies it on the ENTRY document (T3).
      const token = signDevTunnelAccessToken({ userId: user.id, host });
      iframeSrc = `https://${host}/?dev=${encodeURIComponent(token)}`;
    }
  }

  return {
    appBlockId: app.appBlockId,
    blockId: app.blockId,
    appId: app.appId,
    appName: app.name,
    trustTier: app.trustTier,
    sandbox: app.sandbox,
    scopes: app.scopes,
    bootSkeleton: app.bootSkeleton,
    iframeSrc,
    host,
    dnsPending,
    ...(direct && iframeSrc ? { transport: 'direct' as const } : {}),
  };
}
