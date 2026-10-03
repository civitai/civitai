import { Box, Button, Group, Text, Tooltip } from '@mantine/core';
import { IconShieldCheck, IconX } from '@tabler/icons-react';
import classes from './BlockConsentNotice.module.scss';

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
 *
 * ── THE NARROW FORM ─────────────────────────────────────────────────────────────
 *
 * 🔴 ONE ELEMENT PER CONTROL, WITH ITS CONTENT SWAPPED BY CSS — NOT TWO ELEMENTS,
 * ONE OF THEM HIDDEN. Rendering a `Button` and an `ActionIcon` and letting a media
 * query pick would DUPLICATE `data-testid="block-consent-notice-review"` and
 * `…-dismiss` in the DOM, and the three existing suites that drive this notice
 * (`PageBlockHost.browser.test.tsx`, `IframeHostConsentNotice.browser.test.tsx`)
 * resolve those ids strictly — two matches is an error, not a pick. So each control
 * is a SINGLE button carrying the id, and what swaps is the LABEL inside it: an icon
 * below `xs`, the word above it. The testids, the click handlers and the accessible
 * names are therefore width-INDEPENDENT, which is also the property worth having
 * regardless of the ids.
 *
 * 🔴 EACH BUTTON CARRIES AN EXPLICIT `aria-label`, BECAUSE AT NARROW WIDTHS ITS ONLY
 * CONTENT IS AN ICON — i.e. it would be named by nothing. `aria-label` overrides
 * visible text, so the review button's label is the EXACT string its wide form
 * shows; a label that merely paraphrased the visible word would break "label in
 * name" for anyone driving this by voice. The dismiss button keeps the longer label
 * it already had, which is the name the existing suites read.
 *
 * The swap itself is a CONTAINER query against this notice's own box, not a viewport
 * query — the reason is on `.notice` in `BlockConsentNotice.module.scss`, and it is
 * the model sidebar, not the phone, that makes it necessary.
 */
export function BlockConsentNotice({ appName, onReview, onDismiss }: BlockConsentNoticeProps) {
  return (
    <Box
      role="status"
      data-testid="block-consent-notice"
      className={classes.notice}
      px="md"
      py="xs"
      style={{
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: 'var(--mantine-color-body)',
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap="sm" align="center">
        <Text size="sm" className={classes.message}>
          <span className={classes.wideOnly}>
            {appName ?? 'This app'} is missing permissions it needs to work fully.
          </span>
          {/* Short, and deliberately WITHOUT the app name: this bar is rendered directly
              above the app it is about, so the name is the one word the narrow form can
              drop without losing the referent. */}
          <span className={classes.narrowOnly}>Missing permissions</span>
        </Text>
        <Group gap="xs" wrap="nowrap" className={classes.actions}>
          <Tooltip label="Review permissions" withArrow>
            <Button
              size="compact-sm"
              variant="light"
              aria-label="Review permissions"
              data-testid="block-consent-notice-review"
              onClick={onReview}
            >
              <IconShieldCheck size={16} className={classes.narrowOnly} />
              <span className={classes.wideOnly}>Review permissions</span>
            </Button>
          </Tooltip>
          <Tooltip label="Dismiss" withArrow>
            <Button
              size="compact-sm"
              variant="subtle"
              aria-label="Dismiss the missing-permissions notice"
              data-testid="block-consent-notice-dismiss"
              onClick={onDismiss}
            >
              <IconX size={16} className={classes.narrowOnly} />
              <span className={classes.wideOnly}>Dismiss</span>
            </Button>
          </Tooltip>
        </Group>
      </Group>
    </Box>
  );
}
