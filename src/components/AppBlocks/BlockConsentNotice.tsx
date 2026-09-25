import { Box, Button, Group, Text } from '@mantine/core';

type BlockConsentNoticeProps = {
  /** The app's display name, as the host surface knows it. */
  appName?: string;
  /** Open the consent modal. The caller RE-RESOLVES the scope set at click time. */
  onReview: () => void;
  /** Retire the notice for this app, for this mount. */
  onDismiss: () => void;
};

/**
 * 🔴 THE MISSING-PERMISSIONS BACKSTOP, RENDERED OUTSIDE THE IFRAME.
 *
 * The mint is FAIL-CLOSED on a missing `app_user_scope_grants` row, so a viewer who
 * has never consented gets a token with every consent-gated scope withheld — and
 * until this existed the ONLY thing that could tell them was the block itself, via
 * REQUEST_CONSENT. An app that did not think to ask left the viewer with a
 * working-looking control that could never succeed.
 *
 * Measured 2026-09-08 on `playable-collections`: a real 2-Buzz tip was refused on
 * both legs at the scope gate, the Buzz ledger confirms nothing moved, and the
 * viewer saw only "None of that tip came back confirmed" — no prompt, no
 * explanation, permanently. `social:tip:self` was granted on ONE row in the whole
 * grants table, so that was the ORDINARY path.
 *
 * 🔴 OUTSIDE THE IFRAME, NOT INSIDE IT, ON BOTH SURFACES. The whole point is that
 * the host is recoverable regardless of what the block does — including a block
 * that never calls `requestGrants`, and a block running an SDK version with no such
 * call. Anything rendered by the block cannot satisfy that, and anything a block can
 * restyle or hide is not a backstop. Both hosts render it between the `AppBlockChrome`
 * provenance bar and the app's own box, which is host-owned chrome in both cases.
 *
 * 🔴 A NOTICE, NOT AN AUTO-OPENED MODAL, DELIBERATELY. A block can be fully usable
 * unconsented — `collections:read:self` is consent-exempt, so `playable-collections`
 * browses public collections fine with no grant at all — and an unconditional modal
 * would interrupt every viewer of every app that merely DECLARES a consent-gated
 * scope. The viewer decides.
 *
 * 🔴 PRESENTATION ONLY. Every condition deciding whether this appears lives in
 * `resolveHostConsentNotice` (`requestConsentGate.ts`), shared by both hosts. Do not
 * add a gate here: a second place for the same rule is exactly how the model slot
 * came to have no backstop for the whole life of the page host's.
 *
 * `role="status"` rather than `role="alert"`: it is an offer the viewer can ignore,
 * so it must not seize a screen reader mid-sentence.
 */
export function BlockConsentNotice({ appName, onReview, onDismiss }: BlockConsentNoticeProps) {
  return (
    <Box
      role="status"
      data-testid="block-consent-notice"
      px="md"
      py="xs"
      style={{
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: 'var(--mantine-color-body)',
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Text size="sm">
          {appName ?? 'This app'} is missing permissions it needs to work fully.
        </Text>
        <Group gap="xs" wrap="nowrap">
          <Button
            size="compact-sm"
            variant="light"
            data-testid="block-consent-notice-review"
            onClick={onReview}
          >
            Review permissions
          </Button>
          <Button
            size="compact-sm"
            variant="subtle"
            aria-label="Dismiss the missing-permissions notice"
            data-testid="block-consent-notice-dismiss"
            onClick={onDismiss}
          >
            Dismiss
          </Button>
        </Group>
      </Group>
    </Box>
  );
}
