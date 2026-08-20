import { Button } from '@mantine/core';
import { useState } from 'react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The moderator review modal's FOCUS RETURN, under the `Modal.Stack` it joined so that
 * a nested screenshot viewer could scope its own Escape.
 *
 * 🔴 THIS FILE EXISTS BECAUSE THE STACK BROKE SOMETHING THAT USED TO WORK, AND IT BROKE
 * IT UNCONDITIONALLY — not only when the nested viewer was used. Inside a stack
 * `trapFocus` is `ctx.currentId === stackId`, and the stack registers its members from
 * an effect, so even a lone modal renders once with the trap OFF and again with it ON.
 * `useModal` passes that into `useFocusReturn({ opened, shouldReturnFocus: trapFocus &&
 * returnFocus })`, whose deps are `[opened, shouldReturnFocus]` — so the flip re-runs
 * that effect while `opened` is still true and overwrites the captured opener with
 * whatever holds focus by then. Measured, three arms differing only in the wrapper:
 *
 *     without Modal.Stack                     focus -> the trigger   ✅
 *     with Modal.Stack                        focus -> <body>        ❌
 *     with Modal.Stack + returnFocus={false}  focus -> <body>        ❌
 *
 * The third arm is the one that matters for the fix: switching Mantine's version off
 * restores nothing by itself, which is why `useOpenerFocusReturn` exists.
 *
 * 🔴 THE CONVERSE IS NOT ESTABLISHED, and an earlier draft of this header claimed it
 * was ("a PAIR, not an alternative"). A mutation sweep deleted `returnFocus={false}`
 * while keeping the hook and BOTH tests below stayed green; only the source gate
 * noticed. The two are still used together, as a single-owner convention, but this
 * file measures the HOOK — it is not evidence that the prop is load-bearing.
 *
 * 🔴 ASSERTED AS A RELATIONSHIP: focus must land on THE ELEMENT THAT OPENED the modal,
 * not merely "not on `<body>`". A moderator working the queue by keyboard has to get
 * their row back; landing on some other control, or on the page container, is a
 * different bug wearing the same green.
 */

// 🔴 BOTH the fixture and the spy live in `vi.hoisted`, because the `vi.mock`
// factory below closes over them and `vi.mock` is hoisted to the top of the file. A
// plain top-level `const` referenced from the factory is a temporal-dead-zone read:
// vitest reports "There was an error when mocking a module … no top level variables
// inside", the suite produces NO summary line at all, and under load the run wedges
// rather than failing — which reads as an infrastructure problem rather than a defect
// in this file. (A neighbouring suite gets away with the plain form; that is luck of
// evaluation order, not a pattern to copy.)
const hoisted = vi.hoisted(() => ({
  invalidate: vi.fn().mockResolvedValue(undefined),
  row: {
    id: 'req-1',
    appListingId: 'listing-1',
    slug: 'ci-ext-app',
    status: 'pending',
    submittedAt: new Date('2026-01-01T00:00:00Z'),
    changelog: 'a note for the reviewer',
    appListing: {
      name: 'CI External App',
      externalUrl: 'https://example.com/app',
      category: 'utility',
      contentRating: 'g',
    },
    submittedBy: { id: 42, username: 'author-dev', image: null },
  },
}));

const OFFSITE_ROW = hoisted.row;

// 🔴 `importOriginal` SPREAD, not a wholesale replacement (local-rules/
// no-wholesale-module-mock) — mirrors `OffsiteReviewQueue.browser.test.tsx`, whose
// header records what a hand-written factory costs the day the graph grows an export.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocks: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: {
      useUtils: () => ({
        appListings: {
          listPendingRequests: { invalidate: hoisted.invalidate },
          listApprovedRequests: { invalidate: hoisted.invalidate },
          listRejectedRequests: { invalidate: hoisted.invalidate },
        },
      }),
      appListings: {
        listPendingRequests: {
          useQuery: () => ({
            data: { items: [hoisted.row], nextCursor: null },
            isLoading: false,
            error: null,
          }),
        },
        getAssets: { useQuery: () => ({ data: null, isLoading: false, error: null }) },
        approveExternalRequest: {
          useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
        },
        rejectExternalRequest: {
          useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
        },
        getListingPreviewForReview: {
          useQuery: () => ({ data: undefined, isLoading: false, error: null }),
        },
      },
    },
  };
});

const { OffsiteReviewModal } = await import('./OffsiteReviewQueue');

beforeEach(async () => {
  await page.viewport(1440, 900);
});

/** A trigger button plus the modal — the shape the queue's `Review` button renders. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-testid="opener" onClick={() => setOpen(true)}>
        Review
      </Button>
      <OffsiteReviewModal
        request={open ? (OFFSITE_ROW as never) : null}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

const opener = () => document.querySelector('[data-testid="opener"]') as HTMLElement;
const dialog = () => document.querySelector('[role="dialog"][aria-modal="true"]');

async function openModal() {
  await renderWithProviders(<Harness />);
  const trigger = opener();
  trigger.focus();
  expect(document.activeElement).toBe(trigger);
  await userEvent.click(trigger);
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  // Control: focus really left the trigger, so what follows is a restore rather than
  // focus that never moved.
  await vi.waitFor(() => expect(document.activeElement).not.toBe(trigger));
  return trigger;
}

describe('OffsiteReviewModal — focus return under Modal.Stack', () => {
  /**
   * 🔴 THE REGRESSION. The nested viewer is never opened here — this is the plain
   * open-then-close path every moderator takes, and it is the arm that measured
   * `<body>` before the fix.
   */
  test('closing with Escape returns focus to the element that opened it', async () => {
    const trigger = await openModal();

    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(dialog()).toBeNull());

    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  /**
   * The same claim through the close BUTTON rather than Escape — the fix hangs off the
   * `opened` transition, not off which affordance caused it, and that should be
   * measured rather than assumed.
   */
  test('closing with the close button returns focus to the opener too', async () => {
    const trigger = await openModal();

    // 🔴 Located STRUCTURALLY, by Mantine's own close-button class, not by an
    // accessible name: this modal does not set `closeButtonProps`, so its close button
    // has no `aria-label` and `getByRole('button', { name: … })` matches nothing —
    // which times out after 15s and reads exactly like the focus assertion failing.
    // (That the button is unlabelled is a real a11y gap, but it is pre-existing and
    // not this PR's to change.)
    const close = document.querySelector(
      '[role="dialog"] button[class*="mantine-Modal-close"]'
    ) as HTMLElement | null;
    expect(close, 'the review modal has no close button').not.toBeNull();
    close!.click();
    await vi.waitFor(() => expect(dialog()).toBeNull());

    await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
