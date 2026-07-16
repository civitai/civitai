import { Alert, Loader, Stack, Text, useComputedColorScheme } from '@mantine/core';
import { useEffect } from 'react';
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * MOD REVIEW SANDBOX (#2831) — the on-site preview HOST bridge.
 *
 * This is the missing half of the review handshake: `ReviewPreviewPanel` used to
 * embed the review host as a RAW `<iframe src>` with no host bridge, so nothing
 * ever posted `BLOCK_INIT` and the SDK block hung on "Connecting to host". This
 * component mounts the REAL production `PageBlockHost` against the review iframe,
 * so a PENDING un-approved block actually renders inside the mod's review modal.
 *
 * It runs UNAPPROVED, untrusted code with the MOD's session, so it is deliberately
 * the WEAKEST-privilege mount, layered defense-in-depth (no single layer
 * load-bearing):
 *   1. TOKEN — the block token comes from `blocks.mintReviewBlockToken` (mod-gated,
 *      self-bound to the mod, render-only scope-stripped, forced-SFW, synthetic
 *      non-resolving ids, short TTL). See the router + publish-request.service.
 *   2. SANDBOX — `trustTier` is FORCED to `'unverified'` regardless of the
 *      manifest's declared tier, so `intersectSandbox` drops `allow-same-origin`
 *      → the iframe runs at an OPAQUE origin (the C1 self-escalation defense).
 *      PageBlockHost derives its opaque postMessage transport from that same
 *      sandbox string internally (usePostMessage), so BLOCK_INIT is posted with
 *      `targetOrigin:'*'` and inbound `origin:'null'` is accepted — the exact path
 *      every unverified prod block at `<slug>.civit.ai` already uses. No new
 *      opaque-origin prop is needed.
 *   3. HOST — `reviewMode` makes every side-effecting / money / private / cross-user
 *      host handler reply with a fail-fast NACK instead of doing the work.
 *
 * The mount is isolated in its OWN component (rendered only when the preview is
 * live) so `ReviewPreviewPanel`'s render path — and the OnsiteReviewModal browser
 * test that never reaches a live preview — never evaluates these hooks.
 */
export function ReviewBlockPreviewHost({
  publishRequestId,
  slug,
  iframeSrc,
}: {
  publishRequestId: string;
  slug: string;
  /** The stabilized `?mr=<entry-token>` review host URL from ReviewPreviewPanel
   *  (pickReviewIframeSrc keeps it stable across polls; the `?mr=` token is only
   *  the mod-gate ENTRY token, not the block token minted below). */
  iframeSrc: string;
}) {
  const currentUser = useCurrentUser();
  const colorScheme = useComputedColorScheme('dark');
  const theme: 'light' | 'dark' = colorScheme === 'dark' ? 'dark' : 'light';

  // Mint the SELF-BOUND, scope-stripped block token (mod-gated mutation). Minted
  // once when the preview goes live; re-mintable on demand via onRetryToken (the
  // 4h dev-lifetime token comfortably outlives a review session).
  const mintMut = trpc.blocks.mintReviewBlockToken.useMutation();
  const { mutate: mint, data: mintData, isError: mintError, isPending } = mintMut;

  useEffect(() => {
    // Fire once on mount for this live preview. React 18 StrictMode double-invokes
    // effects in dev; `isPending`/`mintData` guards keep it to a single in-flight
    // mint, and a duplicate mint is harmless (idempotent, audited).
    if (!mintData && !isPending && !mintError) {
      mint({ publishRequestId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publishRequestId]);

  if (mintError) {
    return (
      <Alert color="red" variant="light">
        Could not mint the review preview token. Rebuild the preview or try again.
      </Alert>
    );
  }

  if (!mintData) {
    return (
      <Stack align="center" gap={6} p="md">
        <Loader size="sm" />
        <Text size="xs" c="dimmed">
          Connecting to the review host…
        </Text>
      </Stack>
    );
  }

  const viewer = currentUser
    ? { id: currentUser.id, username: currentUser.username ?? null }
    : null;

  return (
    <PageBlockHost
      appBlockId={mintData.appBlockId}
      blockId={mintData.blockId}
      appId={mintData.appId}
      blockInstanceId={mintData.blockInstanceId}
      appName={mintData.appName}
      iframeSrc={iframeSrc}
      sandbox={mintData.sandbox}
      // FORCED unverified → opaque origin (drops allow-same-origin). C1 defense.
      trustTier="unverified"
      slug={slug}
      token={mintData.token}
      expiresAt={mintData.expiresAt}
      declaredScopes={mintData.scopes}
      missingScopes={[]}
      needsConsent={false}
      tokenError={false}
      domain={mintData.domain}
      maxBrowsingLevel={mintData.maxBrowsingLevel}
      viewer={viewer}
      theme={theme}
      // Read-only host: every side-effecting/money/private handler NACKs.
      reviewMode
      // Re-mint the block token on an auth-failure Retry.
      onRetryToken={() => mint({ publishRequestId })}
    />
  );
}
