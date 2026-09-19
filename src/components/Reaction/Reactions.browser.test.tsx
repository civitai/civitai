import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ReactElement, ReactNode } from 'react';
import type * as TrpcUtils from '~/utils/trpc';
import type * as TipBuzzButton from '~/components/Buzz/InteractiveTipBuzzButton';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';

// =============================================================================
// Unknown reaction counts vs real zeros (868m6v0ak).
//
// A count ClickHouse could not answer is UNKNOWN, not zero. Before this change
// both rendered the same thing on a card — and that thing was *nothing*, because
// `ReactionButton` drops a zero-count badge when `noEmpty` is set (the default,
// `showAll === false`). So the property under test is not "two numbers differ",
// it is "unknown has somewhere to appear at all".
//
// The zero baseline is asserted in every case that claims a difference, because a
// test that only looks at the unknown render cannot see the two collapsing back
// together.
// =============================================================================

const mocks = vi.hoisted(() => ({
  toggle: vi.fn(),
  // ON by default: every case below except the kill-switch block is about what the
  // unknown state LOOKS like, which only exists with the flag on.
  flags: { reactionCountsUnknown: true } as { reactionCountsUnknown?: boolean },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcUtils>()),
  trpc: {
    reaction: { toggle: { useMutation: () => ({ mutate: mocks.toggle, isPending: false }) } },
    useUtils: () => ({}),
  },
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => mocks.flags,
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 1, muted: false }),
}));

// Boundary stub for the tip cases only: the real button needs a ContainerProvider this
// harness has no reason to mount, and throws the whole tree away without one. Spread
// rather than replaced, so `useBuzzTippingStore` -- which supplies the session-local
// delta the badge adds to the count -- stays real and the number under test is genuine.
vi.mock('~/components/Buzz/InteractiveTipBuzzButton', async (importOriginal) => ({
  ...(await importOriginal<typeof TipBuzzButton>()),
  InteractiveTipBuzzButton: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { renderWithProviders } from '../../../test/component-setup';
import { Reactions } from '~/components/Reaction/Reactions';

// All four reactions resolved, and nobody reacted. A REAL zero.
const allZero = { likeCount: 0, heartCount: 0, laughCount: 0, cryCount: 0 };

// `[aria-label$="reaction"]` would also match the "Add reaction" button, which is
// not a badge — an earlier version of this file counted it and read 1 as 0's failure.
const badges = () =>
  Array.from(document.querySelectorAll('[aria-label]')).filter((el) =>
    /^(Like|Dislike|Heart|Laugh|Cry) reaction$/.test(el.getAttribute('aria-label') ?? '')
  );

const placeholder = () => document.querySelector('[aria-label="Reaction counts unavailable"]');

// Scoped to the row, NOT `document.body`: Mantine injects a <style> block whose
// media queries ("max-width: 35.99375em") put digits in body.textContent, so a
// digit assertion read against the body reports the stylesheet, not the badges.
const renderRow = (ui: ReactElement) => renderWithProviders(<div data-testid="row">{ui}</div>);
const rowText = () => document.querySelector('[data-testid="row"]')?.textContent ?? '';

beforeEach(() => {
  mocks.flags = { reactionCountsUnknown: true };
});

describe('a card', () => {
  test('renders NOTHING for a real zero — the state unknown has to differ from', async () => {
    renderRow(<Reactions entityType="image" entityId={1} reactions={[]} metrics={allZero} />);

    // The row rendered: an empty badge list here is absence, not a dead component.
    await expect.element(page.getByRole('button', { name: 'Add reaction' })).toBeInTheDocument();
    expect(badges().length).toBe(0);
    expect(placeholder()).toBeNull();
    expect(rowText()).not.toContain('0');
  });

  test('renders a placeholder for an unknown count — visibly different from the zero above', async () => {
    renderRow(
      <Reactions entityType="image" entityId={2} reactions={[]} metrics={allZero} metricsUnknown />
    );

    await expect.element(page.getByLabelText('Reaction counts unavailable')).toBeInTheDocument();
    // The distinguishing claim, stated against the zero case's own observables:
    // zero renders no placeholder (asserted above), unknown renders one and still
    // invents no number.
    expect(rowText()).toContain("Couldn't load");
    expect(rowText()).not.toMatch(/\d/);
  });

  test('a real NONZERO count still renders its badge, unchanged', async () => {
    renderRow(
      <Reactions
        entityType="image"
        entityId={3}
        reactions={[]}
        metrics={{ ...allZero, likeCount: 7 }}
      />
    );

    await expect.element(page.getByRole('button', { name: 'Like reaction' })).toBeInTheDocument();
    expect(badges().length).toBe(1);
    expect(placeholder()).toBeNull();
    expect(rowText()).toContain('7');
  });
});

describe('the reaction-counts-unknown kill switch', () => {
  // OFF has to be indistinguishable from before this change: the server still marks
  // the counts unknown, and the component must ignore it. Each case pairs with the
  // identical fixture flag-ON elsewhere in this file, which renders the placeholder.
  test('OFF: an unknown count on a card renders nothing, exactly like a zero', async () => {
    mocks.flags = { reactionCountsUnknown: false };
    renderRow(
      <Reactions entityType="image" entityId={13} reactions={[]} metrics={allZero} metricsUnknown />
    );

    await expect.element(page.getByRole('button', { name: 'Add reaction' })).toBeInTheDocument();
    expect(placeholder()).toBeNull();
    expect(badges().length).toBe(0);
  });

  test('OFF: an unknown count expanded renders 0, not a dash', async () => {
    mocks.flags = { reactionCountsUnknown: false };
    renderRow(
      <Reactions
        entityType="image"
        entityId={14}
        reactions={[]}
        metrics={allZero}
        metricsUnknown
        showAll
      />
    );

    await expect.element(page.getByRole('button', { name: 'Like reaction' })).toBeInTheDocument();
    expect(badges().every((b) => b.textContent?.includes('0'))).toBe(true);
    expect(rowText()).not.toContain('–');
  });

  test('a flags object WITHOUT the key reads as off', async () => {
    // What a Flipt that has never heard of the flag, or a flags snapshot from before
    // it existed, hands the client. It must get the silent zero, not the badge.
    mocks.flags = {};
    renderRow(
      <Reactions entityType="image" entityId={15} reactions={[]} metrics={allZero} metricsUnknown />
    );

    await expect.element(page.getByRole('button', { name: 'Add reaction' })).toBeInTheDocument();
    expect(placeholder()).toBeNull();
  });
});

describe('a READONLY surface', () => {
  // `Reactions` returns null when `readonly && !hasReactions`, which exists to drop
  // entities nobody reacted to. Unknown counts are not that, so the component forces
  // `hasReactions`. Nothing covered this until the review: deleting that one line left
  // all seven other cases green while restoring the original bug on the readonly feed
  // card (ImagesCard.tsx renders <Reactions readonly={readonly} />).
  test('renders NOTHING for a real zero', async () => {
    renderRow(
      <Reactions entityType="image" entityId={8} reactions={[]} metrics={allZero} readonly />
    );

    // Absorbing: readonly suppresses the add-reaction button too, so the row is empty
    // and stays empty. Asserted after the unknown case below has proven the same
    // fixture CAN produce a placeholder.
    await expect.element(page.getByTestId('row')).toBeInTheDocument();
    expect(badges().length).toBe(0);
    expect(placeholder()).toBeNull();
  });

  test('still renders the placeholder for an unknown count', async () => {
    renderRow(
      <Reactions
        entityType="image"
        entityId={9}
        reactions={[]}
        metrics={allZero}
        metricsUnknown
        readonly
      />
    );

    await expect.element(page.getByLabelText('Reaction counts unavailable')).toBeInTheDocument();
  });
});

describe('an expanded row (showAll)', () => {
  test('a real zero renders four badges reading 0', async () => {
    renderRow(
      <Reactions entityType="image" entityId={4} reactions={[]} metrics={allZero} showAll />
    );

    await expect.element(page.getByRole('button', { name: 'Like reaction' })).toBeInTheDocument();
    expect(badges().length).toBe(4);
    expect(badges().every((b) => b.textContent?.includes('0'))).toBe(true);
  });

  test('an unknown count renders the same four badges reading an en dash, never a number', async () => {
    renderRow(
      <Reactions
        entityType="image"
        entityId={5}
        reactions={[]}
        metrics={allZero}
        metricsUnknown
        showAll
      />
    );

    await expect.element(page.getByRole('button', { name: 'Like reaction' })).toBeInTheDocument();
    expect(badges().length).toBe(4);
    expect(badges().every((b) => b.textContent?.includes('–'))).toBe(true);
    // Against the zero case directly above, which reads `0` on all four.
    expect(badges().some((b) => /\d/.test(b.textContent ?? ''))).toBe(false);
  });
});

describe('the buzz tip count', () => {
  // `tippedAmountCountAllTime` comes from `match?.buzz` -- the SAME unresolved row as
  // the reactions -- and BuzzTippingBadge renders outside the placeholder branch. So
  // an unknown card was showing "Couldn't load" beside a confident 0. No earlier case
  // caught it because none passed `targetUserId`, without which the badge never mounts.
  test('a real zero tip count renders 0', async () => {
    renderRow(
      <Reactions
        entityType="image"
        entityId={10}
        reactions={[]}
        metrics={{ ...allZero, tippedAmountCount: 0 }}
        targetUserId={99}
      />
    );

    await expect.element(page.getByTestId('row')).toBeInTheDocument();
    expect(rowText()).toContain('0');
  });

  test('an unknown tip count renders a dash, not 0', async () => {
    renderRow(
      <Reactions
        entityType="image"
        entityId={11}
        reactions={[]}
        metrics={{ ...allZero, tippedAmountCount: 0 }}
        targetUserId={99}
        metricsUnknown
      />
    );

    await expect.element(page.getByLabelText('Reaction counts unavailable')).toBeInTheDocument();
    // The whole row, tip badge included, carries no digit -- measured against the
    // case directly above, where the identical fixture renders one.
    expect(rowText()).toContain('–');
    expect(rowText()).not.toMatch(/\d/);
  });
});

describe('the optimistic count', () => {
  // 🔴 `ReactionButton` computes `initialCount + 1` when the viewer reacts. With a
  // count we do not have, that arithmetic produces a FABRICATED number — worse than
  // either zero or unknown, because it looks like a measurement. These two cases
  // drive the click and assert no digit ever appears.
  test('a viewer who already reacted sees a dash, not 1', async () => {
    renderRow(
      <Reactions
        entityType="image"
        entityId={6}
        reactions={[{ userId: 1, reaction: 'Like' }]}
        metrics={allZero}
        metricsUnknown
        showAll
      />
    );

    const like = page.getByRole('button', { name: 'Like reaction' });
    await expect.element(like).toBeInTheDocument();
    expect(like.element().textContent).toContain('–');
    expect(like.element().textContent).not.toMatch(/\d/);
  });

  test('clicking an unknown-count reaction invents no number', async () => {
    renderRow(
      <Reactions
        entityType="image"
        entityId={7}
        reactions={[]}
        metrics={allZero}
        metricsUnknown
        showAll
      />
    );

    const like = page.getByRole('button', { name: 'Like reaction' });
    await expect.element(like).toBeInTheDocument();
    // A DOM click, not `userEvent.click`: the harness loads no stylesheet, so the
    // badge's geometry makes playwright's actionability check load-sensitive — it
    // passed in ~300ms alone and timed out at 15s sharing the run with one other
    // browser file. The toggle assertion below is what proves the click landed, so
    // nothing is lost by not routing through the pointer.
    like.element().dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // The reaction itself still registers — this is not "the button stopped working".
    expect(mocks.toggle).toHaveBeenCalled();
    // ...but the count stays unknown, because the toggle taught us nothing about it.
    expect(like.element().textContent).toContain('–');
    expect(like.element().textContent).not.toMatch(/\d/);
  });

  test('CONTROL: the same click DOES move a known count, so the case above is not vacuous', async () => {
    // Without this arm, "no digit after the click" would also pass if the dispatched
    // event never re-rendered anything at all — the pre-click state is already a dash.
    renderRow(
      <Reactions
        entityType="image"
        entityId={12}
        reactions={[]}
        metrics={{ ...allZero, likeCount: 4 }}
        showAll
      />
    );

    const like = page.getByRole('button', { name: 'Like reaction' });
    await expect.element(like).toBeInTheDocument();
    expect(like.element().textContent).toContain('4');

    like.element().dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await expect.element(like).toHaveTextContent('5');
  });
});
