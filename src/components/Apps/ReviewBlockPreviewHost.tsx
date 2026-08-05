import { Alert, Button, Group, Loader, Stack, Text, useComputedColorScheme } from '@mantine/core';
import { IconAlertTriangle, IconPlayerPlay, IconShieldLock } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';
import { clampReviewSandbox } from '~/components/AppBlocks/sandbox';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { REVIEW_RUN_FOR_REAL_BUZZ_CAP } from '~/shared/constants/block-scope.constants';
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
 * RUN FOR REAL (opt-in): a moderator may EXPLICITLY opt in, per-preview, to run the
 * app FOR REAL against THEIR OWN account (generation / own-Buzz / per-user storage)
 * so they can fully evaluate it before approving. It is:
 *   - LOUD-CONSENT-GATED (default OFF; the mod must confirm a clear warning);
 *   - RE-MINTED server-side with `runForReal:true` — the token stays SELF-BOUND,
 *     forced-SFW, clamped to (declared ∩ run-for-real allowlist); money-OUT and
 *     cross-user are NEVER granted; spend is bounded by a per-call budget AND a
 *     tight aggregate session Buzz cap (`REVIEW_RUN_FOR_REAL_BUZZ_CAP`);
 *   - SERVER-AUTHORITATIVE — the host only un-NACKs when the MINTED token actually
 *     came back `runForReal:true` (`mintData.runForReal`), never off local UI state;
 *   - REVERSIBLE — "Exit run-for-real" re-mints the render-only token; the whole
 *     preview is torn down on the approve/reject decision.
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
  const features = useFeatureFlags();
  const colorScheme = useComputedColorScheme('dark');
  const theme: 'light' | 'dark' = colorScheme === 'dark' ? 'dark' : 'light';

  // Mint the SELF-BOUND, scope-stripped block token (mod-gated mutation). Minted
  // once render-only when the preview goes live; RE-mintable on demand to flip
  // between render-only and run-for-real, and on an auth-failure retry.
  const mintMut = trpc.blocks.mintReviewBlockToken.useMutation();
  const { mutate: mint, data: mintData, isError: mintError, isPending } = mintMut;

  // Consent gate state — the mod arms (shows the loud warning) then confirms. The
  // ACTIVE run-for-real state is read from the MINTED token (`mintData.runForReal`,
  // server truth), never from this UI flag alone — that is what gates the host.
  const [consentArmed, setConsentArmed] = useState(false);

  const doMint = useCallback(
    (runForReal: boolean) => mint({ publishRequestId, runForReal }),
    [mint, publishRequestId]
  );

  useEffect(() => {
    // Fire once on mount for this live preview — ALWAYS render-only first (the
    // default sandbox). React 18 StrictMode double-invokes effects in dev; a
    // duplicate mint is harmless (idempotent, audited, rate-limited only for the
    // run-for-real path).
    doMint(false);
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

  // SERVER TRUTH: only treat run-for-real as active when the MINTED token came back
  // runForReal:true (the token is what actually carries the wider scopes + budget).
  const runForRealActive = mintData.runForReal === true;
  const buzzCap = mintData.buzzCap ?? REVIEW_RUN_FOR_REAL_BUZZ_CAP;

  return (
    <Stack gap="xs">
      {runForRealActive ? (
        // PERSISTENT banner while run-for-real is active. Stays visible for the
        // whole run-for-real session so the mod is never unaware their OWN account
        // is being spent against by an unapproved app.
        <Alert
          color="red"
          variant="filled"
          icon={<IconAlertTriangle size={18} />}
          data-testid="review-run-for-real-banner"
        >
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text size="sm" fw={600}>
              RUN FOR REAL is active — this UNAPPROVED app is running for real against YOUR
              account and spending YOUR Buzz (capped at {buzzCap}). SFW enforced.
            </Text>
            <Button
              size="xs"
              color="gray"
              variant="white"
              onClick={() => {
                setConsentArmed(false);
                doMint(false);
              }}
              loading={isPending}
              data-testid="review-run-for-real-exit"
            >
              Exit run-for-real
            </Button>
          </Group>
        </Alert>
      ) : consentArmed ? (
        // LOUD consent gate — shown after the mod arms the toggle, BEFORE any
        // run-for-real token is minted. Copy states exactly what will happen +
        // the enforced cap + SFW.
        <Alert
          color="orange"
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title="Run this UNAPPROVED app for real?"
          data-testid="review-run-for-real-consent"
        >
          <Stack gap="xs">
            <Text size="sm">
              This runs an UNAPPROVED app for real against YOUR account and spends YOUR Buzz,
              capped at {buzzCap}. SFW enforced. Generation, your own Buzz balance, and per-user
              storage will use your real account; cross-user actions and money-out stay disabled.
            </Text>
            <Group gap="xs">
              <Button
                size="xs"
                color="red"
                leftSection={<IconPlayerPlay size={14} />}
                onClick={() => {
                  setConsentArmed(false);
                  doMint(true);
                }}
                loading={isPending}
                data-testid="review-run-for-real-confirm"
              >
                Yes, run for real (cap {buzzCap} Buzz)
              </Button>
              <Button
                size="xs"
                variant="default"
                onClick={() => setConsentArmed(false)}
                data-testid="review-run-for-real-cancel"
              >
                Cancel
              </Button>
            </Group>
          </Stack>
        </Alert>
      ) : (
        // DEFAULT: render-only. Offer the opt-in (off by default).
        <Group justify="space-between" wrap="nowrap" gap="sm">
          <Group gap={6} wrap="nowrap">
            <IconShieldLock size={16} />
            <Text size="xs" c="dimmed">
              Read-only preview — side effects are disabled.
            </Text>
          </Group>
          <Button
            size="xs"
            variant="light"
            color="orange"
            leftSection={<IconPlayerPlay size={14} />}
            onClick={() => setConsentArmed(true)}
            data-testid="review-run-for-real-arm"
          >
            Run for real…
          </Button>
        </Group>
      )}

      <PageBlockHost
        // Remount on a mode flip so the new (render-only ↔ run-for-real) token
        // re-handshakes the iframe cleanly instead of swapping a token mid-session.
        key={runForRealActive ? 'run-for-real' : 'render-only'}
        appBlockId={mintData.appBlockId}
        blockId={mintData.blockId}
        appId={mintData.appId}
        blockInstanceId={mintData.blockInstanceId}
        appName={mintData.appName}
        iframeSrc={iframeSrc}
        // Moderator review surfaces (the review modal and the full-page
        // preview both mount PageBlockHost through this component).
        surface="review-preview"
        // Clamp the manifest sandbox to the review render-only set: drop
        // allow-popups / allow-downloads / allow-modals / allow-pointer-lock (+ the
        // top-nav / escape tokens intersectSandbox already strips) so an untrusted
        // review block can't open a popup or trigger a download aimed at the mod's
        // tab. Keeps allow-scripts (+ allow-forms if declared).
        sandbox={clampReviewSandbox(mintData.sandbox)}
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
        // Read-only host by default: every side-effecting/money/private handler
        // NACKs. When (and only when) the SERVER minted a run-for-real token, the
        // self-bound / money-in / own-Buzz / per-user-storage handlers run for real.
        reviewMode
        reviewRunForReal={runForRealActive}
        // Re-mint the block token on an auth-failure Retry, preserving the mode.
        onRetryToken={() => doMint(runForRealActive)}
        // The chrome's "Recently run" menu links to `/apps/run/<blockId>`, gated
        // on the VIEWER having BOTH `appBlocks` and `appBlocksPages` — the
        // reviewer gate that lets a mod reach this preview proves nothing about
        // that route, so read the route's own predicate. (Mods have both today,
        // so this is what restores the menu on the review surface; a reviewer
        // missing either — including during an `appBlocks` kill-switch — gets no
        // dead links.)
        canOpenPage={!!(features.appBlocks && features.appBlocksPages)}
      />
    </Stack>
  );
}
