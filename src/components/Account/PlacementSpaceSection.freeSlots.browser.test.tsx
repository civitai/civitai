import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The free-slot control on the account settings page, and specifically the one
 * property no server test can see: **what this page sends when the creator did
 * not touch it.**
 *
 * `freeSlots` is three-way — NULL follows the surface default, a number stops
 * following it, and 0 is the creator saying no. The mechanism only works while
 * NULL survives an unrelated save. The first version of this control sent the
 * on-screen number on every commit, so changing the mode wrote an explicit `1`;
 * every assertion about the column, the cascade and the resolver stayed green,
 * because each of them was true. Within a few weeks of ordinary use almost every
 * space would have been frozen, and raising the default later would have reached
 * nobody.
 */

const { mutate, spaces, sent, waiting } = vi.hoisted(() => ({
  mutate: vi.fn(),
  spaces: { value: [] as Record<string, unknown>[] },
  sent: { value: [] as { status: string }[] },
  waiting: { value: 0 },
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ stickerPlacement: true }),
}));
vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));
// The received-queue count comes from the notification bell's query now, not
// from this card's own paged fetch — one number instead of two, and no 50-row
// request on a settings page that renders none of them. Mocked at the hook
// rather than at trpc because the hook also reads the announcements provider.
vi.mock('~/components/Notifications/notifications.utils', () => ({
  useQueryNotificationsCount: () => ({ pendingPlacements: waiting.value }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({ placement: { invalidate: vi.fn() } }),
    placement: {
      getPriceRange: {
        useQuery: () => ({ data: { min: 50, max: 500, freeSlotCap: 4, score: 0, tier: 'free' } }),
      },
      getMySpaces: {
        useQuery: () => ({ data: spaces.value, isPending: false, isError: false }),
      },
      // The queue in the OTHER direction — what this creator has placed on other
      // people's images. This mock lists procedures by hand, so a component that
      // starts calling one that isn't here reads `undefined.useQuery` and throws
      // during render: every test in the file then fails as a 15s
      // `getByText('Accept all')` timeout, which names the control rather than
      // the missing procedure. Keep this list level with what the component
      // calls. `getMyStickerPlacements` returns a bare array of rows, not a
      // paged `{ items }` envelope — see `getMyStickerPlacements` in
      // `sticker-placement.service.ts`.
      getMyStickerPlacements: { useQuery: () => ({ data: sent.value }) },
      setSpace: { useMutation: () => ({ mutate, isPending: false }) },
    },
  },
}));

import { PlacementSpaceSection } from '~/components/Account/PlacementSpaceSection';

/** A space row as `getMySpaces` returns it. */
const givenSpace = (freeSlots: number | null) => {
  spaces.value = [
    { entityType: 'user', entityId: 7, mode: 'review', price: 100, freeSlots, settings: {} },
  ];
};

const lastPayload = () => mutate.mock.calls[mutate.mock.calls.length - 1][0];

beforeEach(() => {
  vi.clearAllMocks();
  spaces.value = [];
  sent.value = [];
  waiting.value = 0;
});

describe('PlacementSpaceSection — what a save sends for freeSlots', () => {
  test('an unrelated save leaves a NULL count untouched', async () => {
    givenSpace(null);
    renderWithProviders(<PlacementSpaceSection />);

    await userEvent.click(page.getByText('Accept all'));

    // Absent, not `null`. `null` is a different instruction — it CLEARS the
    // level so it inherits — and both are distinguishable from a number, which
    // is the whole point of the three-way schema. `toHaveProperty` rather than a
    // value comparison, because `undefined` and an omitted key read the same in
    // an equality assertion and only one of them is what the mutation sends.
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(lastPayload()).not.toHaveProperty('freeSlots', null);
    expect(lastPayload().freeSlots).toBeUndefined();
  });

  test('an unrelated save leaves a stored count untouched too', async () => {
    // The stored-number case is not covered by the NULL one. A control that sent
    // its on-screen value would pass here by coincidence — the value happens to
    // match — so this pins that the key is absent rather than that it is right.
    givenSpace(3);
    renderWithProviders(<PlacementSpaceSection />);

    await userEvent.click(page.getByText('Accept all'));

    expect(lastPayload().freeSlots).toBeUndefined();
  });

  // The whole label, not a substring. `/free stickers/i` — which is what the
  // test below matches on — passes just as happily against "Free free stickers
  // you'll accept", the string this page shipped: the slider supplies "Free"
  // and the caller was passing "free stickers" as the noun.
  test('names the control once, not twice', async () => {
    givenSpace(null);
    renderWithProviders(<PlacementSpaceSection />);

    // Found loosely, then asserted exactly, and both halves are deliberate.
    // `name` matches as a case-insensitive SUBSTRING, so locating by the whole
    // correct string finds the broken one too — this test passed with the bug
    // reintroduced until it read the attribute instead (verified by reverting
    // the caller). Reading it also fails in milliseconds with both strings in
    // the message, where a locator that matches nothing spends the 15s budget
    // and reports only that it found nothing.
    const slider = page.getByRole('slider', { name: /accept/i });
    await expect.element(slider).toBeInTheDocument();

    expect(slider.element().getAttribute('aria-label')).toBe("Free stickers you'll accept");
  });

  // The negative control. Without it, "never send freeSlots" would pass every
  // assertion above and the creator could never change the number at all.
  test('moving the control sends the number', async () => {
    givenSpace(null);
    renderWithProviders(<PlacementSpaceSection />);

    const slider = page.getByRole('slider', { name: /free stickers/i });
    await expect.element(slider).toBeInTheDocument();
    // Focused directly and driven by keyboard. A click on the thumb times out —
    // it is a zero-size element the track paints over — and a synthesised drag
    // does not reliably reach Mantine's `onChangeEnd`, which is what commits.
    (slider.element() as HTMLElement).focus();
    await userEvent.keyboard('{ArrowRight}');

    expect(mutate).toHaveBeenCalled();
    // The number CHOSEN, not merely a number. `typeof … === 'number'` passes for
    // a control that sends its pre-move value, which moves the thumb, saves, and
    // stores the old count. Fully determined: the space is unset, so the thumb
    // rests on the surface default of 1 and one ArrowRight makes it 2.
    expect(lastPayload().freeSlots).toBe(2);
  });
});

/**
 * The other half of the same mock, and the reason it is asserted here rather
 * than left as scenery: `pendingCount` is covered in isolation by
 * `queue-counts.test.ts`, and the button is covered nowhere. Neither test can
 * see the join — that the count the filter computes is the number this badge
 * shows — so the filter could be right and the badge still show `rows.length`.
 */
describe('PlacementSpaceSection — the count on the placed-stickers button', () => {
  const placedButton = () => page.getByRole('link', { name: /stickers you.{0,3}ve placed/i });
  const squashed = (el: Element) => el.textContent?.replace(/\s+/g, '');

  test('badges what is still waiting on someone, not everything sent', async () => {
    // Deliberately 2-of-3 rather than all-pending: `rows.length` is 3 here, so a
    // badge that dropped the status filter shows a DIFFERENT number instead of
    // coincidentally the right one. The list is also not empty, which the zero
    // case below cannot distinguish on its own.
    sent.value = [{ status: 'pending' }, { status: 'approved' }, { status: 'pending' }];
    renderWithProviders(<PlacementSpaceSection />);

    const link = placedButton();
    await expect.element(link).toBeInTheDocument();
    // The WHOLE string, not `toHaveTextContent('2')`: a substring check passes
    // on "12" and on a stray digit anywhere else in the button. Whitespace is
    // stripped rather than collapsed because the badge is a sibling element and
    // whether Mantine puts a space before it is layout, not behaviour — the
    // digit is what this test is about.
    expect(squashed(link.element())).toBe("Stickersyou'veplaced2");
  });

  test('carries no badge when nothing is outstanding', async () => {
    // Not the empty list — approved-only. The badge is hidden because the COUNT
    // is zero, and only a non-empty list proves the filter is what zeroed it.
    sent.value = [{ status: 'approved' }];
    renderWithProviders(<PlacementSpaceSection />);

    const link = placedButton();
    await expect.element(link).toBeInTheDocument();
    // A `0` badge is a to-do list with nothing on it; the button has to read as
    // plain text. Exact string again, so a rendered "0" cannot hide in here.
    expect(squashed(link.element())).toBe("Stickersyou'veplaced");
  });
});

/**
 * The received count and the user-menu badge must be the SAME number. This card
 * used to derive its own from one page of `placement.getPending` and render
 * "50+" for anything larger, so an owner with 96 waiting was told 50+ here and
 * 96 in the menu — two answers to one question, and the worse one on the page
 * that exists to explain the queue.
 */
describe('PlacementSpaceSection — the received count', () => {
  test('shows the shared count, not a page-sized floor', async () => {
    waiting.value = 96;
    renderWithProviders(<PlacementSpaceSection />);

    await expect.element(page.getByText('96')).toBeInTheDocument();
  });

  test('renders no badge at all when nothing is waiting', async () => {
    waiting.value = 0;
    renderWithProviders(<PlacementSpaceSection />);

    // The button stays; only the count disappears. A "0" badge reads as broken.
    // Scoped to the button's own text rather than a page-wide search for "0" —
    // the price and free-slot controls render zeros of their own, so a global
    // query passes or fails for reasons that have nothing to do with the badge.
    const label = page.getByText('Review pending stickers');
    await expect.element(label).toBeInTheDocument();
    expect(label.element().closest('a')?.textContent?.trim()).toBe('Review pending stickers');
  });
});
