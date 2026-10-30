import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useComputedColorScheme } from '@mantine/core';
import { PageBlockHost, type PageBlockHostProps } from '~/components/AppBlocks/PageBlockHost';
import { useBlockToken } from '~/components/AppBlocks/useBlockToken';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BlockInstall, PageContext } from '~/components/AppBlocks/types';
import type { DevTunnelFrame } from '~/server/services/blocks/dev-tunnel-frame.service';

export type DevTunnelBlockHostProps = Omit<DevTunnelFrame, 'iframeSrc' | 'host' | 'dnsPending'> & {
  iframeSrc: string;
  /** The page host's terminal fallback, as `PageBlockHostProps.onFallbackChange` reports it. */
  onFallbackChange?: PageBlockHostProps['onFallbackChange'];
  fit: 'viewport' | 'fill';
  /** Shown instead of the app when its dev token cannot be minted. */
  tokenErrorFallback: ReactNode;
  /**
   * The app reloaded itself in the frame (Vite live reload). Fetch a freshly signed entry
   * URL and remount this host with it — key it on `iframeSrc` — exactly as a manual
   * Reload does. See `PageBlockHostProps.onGuestReloaded`.
   */
  onGuestReloaded: () => void;
};

/** The caller's own app, running from its dev tunnel inside the real page host. */
export function DevTunnelBlockHost({
  onFallbackChange,
  appBlockId,
  blockId,
  appId,
  appName,
  iframeSrc,
  bootSkeleton,
  sandbox,
  trustTier,
  scopes,
  fit,
  tokenErrorFallback,
  onGuestReloaded,
}: DevTunnelBlockHostProps) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const colorScheme = useComputedColorScheme('dark');
  const theme: 'light' | 'dark' = colorScheme === 'dark' ? 'dark' : 'light';

  // Synthetic page instance id — same shape as the prod page mint path.
  const blockInstanceId = `page_${appBlockId}`;

  const install = useMemo<BlockInstall>(
    () => ({
      blockInstanceId,
      blockId,
      appId,
      appBlockId,
      manifest: {
        name: appName,
        scopes,
        iframe: {
          src: iframeSrc,
          minHeight: 200,
          maxHeight: null,
          resizable: true,
          sandbox,
        },
      },
      publisherSettings: {},
      enabled: true,
      renderMode: 'iframe',
      trustTier,
    }),
    [appBlockId, appId, appName, blockId, blockInstanceId, iframeSrc, sandbox, scopes, trustTier]
  );

  const context = useMemo<PageContext>(
    () => ({
      slotId: 'app.page',
      entityType: 'none',
      slug: blockId,
      subPath: '',
      viewerUserId: currentUser?.id ?? null,
      viewerUsername: currentUser?.username ?? null,
      theme,
    }),
    [blockId, currentUser, theme]
  );

  const {
    token,
    expiresAt,
    kind,
    needsConsent,
    missingScopes,
    signedScopes,
    domain,
    maxBrowsingLevel,
    effectiveBrowsingLevel,
    error,
    // `terminal` = the mint failed, nothing usable is left, AND the hook's
    // bounded automatic re-mints are spent. A bare `error` is NOT enough to tear
    // down a running page — a transient refresh blip sets it while recovery is
    // still under way — so the mid-session escalation keys on this instead.
    terminal,
    refresh,
  } = useBlockToken(install, context, { devTunnel: true });

  // 🔴 CLIENT-ONLY FRAME. Live reload (`onGuestReloaded`) is detected by counting the
  // frame's `load` events (`isDevTunnelGuestReload`), so every one must be OBSERVED. A
  // frame in the server-rendered HTML starts loading before hydration and can finish
  // before React attaches `onLoad`; that missed load leaves the count one short, so the
  // first reload — a 401 once the entry token has expired, which never reloads again —
  // would go unanswered for good. Mounting after the first client commit costs one
  // effect tick on an author-only page.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (error != null) return <>{tokenErrorFallback}</>;
  if (!mounted) return null;

  const viewer = currentUser
    ? { id: currentUser.id, username: currentUser.username ?? null }
    : null;

  return (
    <PageBlockHost
      appBlockId={appBlockId}
      blockId={blockId}
      appId={appId}
      blockInstanceId={blockInstanceId}
      appName={appName}
      iframeSrc={iframeSrc}
      onFallbackChange={onFallbackChange}
      bootSkeleton={bootSkeleton}
      // 🔴 The author dev tunnel. `resolveDevPageBlockForAuthor` applies NO
      // status filter, so this mounts ARBITRARY UNPUBLISHED code that no
      // query can enumerate. `blockInitFragmentEnabled` refuses this
      // surface unconditionally — no allowlist entry can turn it on.
      surface="dev-tunnel"
      sandbox={sandbox}
      trustTier={trustTier}
      slug={blockId}
      token={token}
      expiresAt={expiresAt}
      tokenKind={kind}
      declaredScopes={scopes}
      missingScopes={missingScopes}
      signedScopes={signedScopes}
      needsConsent={needsConsent}
      domain={domain}
      maxBrowsingLevel={maxBrowsingLevel}
      effectiveBrowsingLevel={effectiveBrowsingLevel}
      tokenError={error != null}
      tokenTerminal={terminal}
      viewer={viewer}
      theme={theme}
      onConsentGranted={refresh}
      onRetryToken={refresh}
      onGuestReloaded={onGuestReloaded}
      // The chrome's "Recently run" menu links to `/apps/run/<blockId>`, which 404s unless the
      // viewer has BOTH flags; see `PageBlockHostProps.canOpenPage`.
      canOpenPage={!!(features.appBlocks && features.appBlocksPages)}
      fit={fit}
    />
  );
}
