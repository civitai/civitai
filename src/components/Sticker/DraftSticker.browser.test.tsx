import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as CosmeticShopUtil from '~/components/CosmeticShop/cosmetic-shop.util';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { resolveTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';

/**
 * What the buttons on a draft actually SEND.
 *
 * `isPlacingFree` is well covered as a function; nothing covered the component
 * using it to fill the payload. Deleting `free: placingFree` from the mutation
 * input left every test in this PR green while every free press charged Buzz —
 * so what is asserted here is the value on the wire, not that a prop of the right
 * type exists.
 */
const IMAGE_ID = 74;
const COSMETIC_ID = 85;
const PRICE = 700;

/** Every press, with its variables, in order. */
const placed: { imageId: number; free: boolean; data: Record<string, unknown> }[] = [];

vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useCreateStickerPlacement: () => ({
    mutate: (variables: (typeof placed)[number]) => placed.push(variables),
    isPending: false,
  }),
}));

/**
 * Mocked because it is a dependency, not the thing under test: the real one
 * renders a currency badge and an account picker and wants the Buzz providers.
 * Reduced to a button that calls what it is given, so a paid press is still
 * observable here — the free press goes through a real Mantine `Button`.
 */
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: ({
    label,
    onPerformTransaction,
  }: {
    label: string;
    onPerformTransaction: () => void;
  }) => (
    // `data-buzz-button` is load-bearing. Without it the stub is
    // indistinguishable from a plain Mantine `Button` by name alone, so swapping
    // the free option TO a BuzzTransactionButton left all ten tests green — the
    // component's own docstring argues at length that it must not be one, and
    // nothing held that argument.
    <button type="button" data-buzz-button onClick={onPerformTransaction}>
      {label}
    </button>
  ),
}));

vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));

// `EdgeImage` resolves its URL through `useCurrentUser`, which reads a session
// context this tree does not mount — and the throw happens inside render, so the
// whole draft comes back empty rather than failing on the missing provider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));

// Every one of these spreads the real module rather than listing its exports. A
// hand-listed mock couples this file to the whole transitive graph of the draft
// and nothing warns when that graph grows — the wholesale `~/utils/trpc` version
// of this file collected ZERO tests, because another module in the graph imports
// `setTrpcBatchingEnabled` and the stub did not provide it.
vi.mock('~/components/CosmeticShop/cosmetic-shop.util', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopUtil>()),
  useMutateCosmeticShop: () => ({ purchaseShopItem: vi.fn(), purchasingShopItem: false }),
}));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useBuyStickerUses: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  return {
    ...actual,
    trpc: {
      ...actual.trpc,
      useUtils: () => ({ cosmetic: { getStickerBalances: { invalidate: vi.fn() } } }),
    },
  };
});

const draft: StickerDraft = {
  id: 'draft-1',
  imageId: IMAGE_ID,
  cosmeticId: COSMETIC_ID,
  x: 0.5,
  // Mid-height and small, so the buy cluster is reachable whichever side of the
  // sticker it settles on. It is absolutely positioned and flips above the
  // sticker when the space below is obstructed, and a cluster that lands outside
  // the harness iframe cannot be scrolled to — Playwright then reports "visible,
  // enabled and stable", fails to scroll, and burns the whole click budget on
  // something that reads as actionable. The container is sized under the default
  // 414x896 viewport for the same reason; 800 wide put it off the right edge.
  y: 0.6,
  scale: 0.25,
  rotation: 15,
  flip: false,
  opacity: 1,
};

const art = { id: COSMETIC_ID, name: 'Star', slug: 'star', url: 'star.png' };

const { DraftSticker } = await import('~/components/Sticker/DraftSticker');

/**
 * `ownerShare` is opt-in, and that is not tidiness.
 *
 * The payout chip is `max-w-[240px]`, and it is the widest child of a `w-max`
 * cluster — so rendering it pushes the cluster's centre far enough left that the
 * Place button lands at a NEGATIVE x, outside the harness iframe and unreachable
 * by any amount of scrolling. Measured: x = -65 in a 414-wide viewport.
 *
 * So the tests that press a button render without it, and the two that assert the
 * chip do not press anything. Splitting them keeps both properties covered
 * without either test depending on the other's layout.
 */
const renderDraft = async (
  freeOffer: { instant: boolean } | null,
  { ownerShare }: { ownerShare?: number } = {}
) => {
  renderWithProviders(
    // Positioned absolutely inside the media box in the app; a plain relative
    // parent is enough here, since none of this asserts geometry.
    // Sized to fit inside the harness iframe rather than to look like a media
    // box: the cluster has to be reachable, and none of this asserts geometry.
    <div style={{ position: 'relative', width: 380, height: 600 }}>
      <DraftSticker
        draft={draft}
        art={art}
        selected
        dressed={resolveTreatment({ treatment: 'none', surface: 'detail', isPending: false })}
        price={PRICE}
        freeOffer={freeOffer}
        ownerShare={ownerShare}
        ownerUsername="creator"
        onGesture={() => true}
      />
    </div>
  );

  // Anchored on the button existing rather than on a name, so an ambiguous
  // locator fails as an assertion instead of a 15 s strict-mode retry.
  await expect.element(page.getByRole('button').first()).toBeInTheDocument();
};

/**
 * The paid button, pressed through the DOM rather than through the locator.
 *
 * ⚠️ **Why this is acceptable here and nowhere else:** `BuzzTransactionButton` is
 * mocked down to a bare `<button onClick={…}>`, so the actionability a locator
 * click would check belongs to the stub rather than to anything shipped. There is
 * no real control here whose reachability could be asserted, whatever method is
 * used — and what these two tests are for is the payload the handler sends. The
 * free press, which is the button this PR added and a real Mantine one, goes
 * through the ordinary locator with its full actionability check.
 *
 * (A locator click on the stub does not succeed in this harness: the cluster is
 * absolutely positioned inside the rotated draft and the paid variant ends up
 * unreachable. The mechanism is NOT established — `shouldFlipPlaceButton` cannot
 * fire here, since `tray` and `clip` are both null — and it is not the reason for
 * the exemption either way.)
 *
 * 🔴 **Four things end this exemption**, and any one of them means going back to a
 * locator click and solving the reachability properly:
 * 1. `BuzzTransactionButton` stops being mocked.
 * 2. Either helper is used to assert reachability, or enabled/disabled state,
 *    rather than the payload.
 * 3. The cluster gains an overlay, so a press could be intercepted.
 * 4. The pattern is copied into another file as habit.
 */
const pressPaid = async () => {
  const button = (await page.getByRole('button', { name: 'Place' }).element()) as HTMLElement;
  button.click();
};

/**
 * The paid segment, pressed the same way and for the same reason — it sits in the
 * same cluster. A Mantine `SegmentedControl` radio is a visually-hidden input
 * besides, so a locator click is waiting on something that is never visible by
 * design.
 */
const choosePaid = async () => {
  const radio = (await page.getByRole('radio', { name: `${PRICE} Buzz` }).element()) as HTMLElement;
  radio.click();
};

beforeEach(() => {
  placed.length = 0;
});

describe('what a draft sends when it is placed', () => {
  test('a free press sends free: true', async () => {
    await renderDraft({ instant: true });

    await page.getByRole('button', { name: 'Place free' }).click();

    expect(placed).toHaveLength(1);
    // The value, not the presence of a correctly-typed prop. `free: false` here
    // is the whole defect: it charges Buzz for a placement somebody chose to
    // make free, and no other test in this PR can see it.
    expect(placed[0].free).toBe(true);
    expect(placed[0].imageId).toBe(IMAGE_ID);
  });

  test('a paid press sends free: false', async () => {
    await renderDraft(null);

    await pressPaid();

    expect(placed).toHaveLength(1);
    expect(placed[0].free).toBe(false);
  });

  /**
   * The default, observed through the payload rather than through the control's
   * selected value — a segmented control reading "free" that sends `free: false`
   * is the failure this file exists for, and only the payload separates them.
   */
  test('defaults to the free offer without anybody choosing it', async () => {
    await renderDraft({ instant: false });

    // No interaction with the segmented control at all.
    await page.getByRole('button', { name: 'Place free' }).click();

    expect(placed[0].free).toBe(true);
  });

  test('sends what was chosen after switching to paid', async () => {
    await renderDraft({ instant: true });

    await choosePaid();
    await pressPaid();

    expect(placed[0].free).toBe(false);
  });

  /**
   * The free option must not be a `BuzzTransactionButton`, which the component's
   * docstring argues at length — that control exists to show a price and check a
   * balance, and a free placement has neither. Asserted through the mock's marker
   * rather than by name, because by name the stub and a plain Mantine button are
   * the same thing: the swap this pins used to leave every test green.
   */
  test('places free through a plain button, not a Buzz one', async () => {
    await renderDraft({ instant: true });

    const free = (await page.getByRole('button', { name: 'Place free' }).element()) as HTMLElement;
    expect(free.hasAttribute('data-buzz-button')).toBe(false);
  });

  test('places paid through a Buzz button, which is where a price belongs', async () => {
    await renderDraft(null);

    const paid = (await page.getByRole('button', { name: 'Place' }).element()) as HTMLElement;
    expect(paid.hasAttribute('data-buzz-button')).toBe(true);
  });

  test('carries the draft geometry either way', async () => {
    await renderDraft({ instant: true });

    await page.getByRole('button', { name: 'Place free' }).click();

    expect(placed[0].data).toMatchObject({
      cosmeticId: COSMETIC_ID,
      x: draft.x,
      y: draft.y,
      scale: draft.scale,
      rotation: draft.rotation,
    });
  });
});

/**
 * The mode belongs to the free option, not to the button upstream, so it has to
 * be readable here — and the two modes have to read differently or the placer
 * cannot tell an instant placement from one that spends their day on a review
 * they may lose.
 */
describe('the free option carries the mode', () => {
  test('says instant on an auto-accept space, with no review caveat', async () => {
    await renderDraft({ instant: true });

    await expect.element(page.getByText('Free · instant')).toBeInTheDocument();
    expect(page.getByText(/spent even if they decline/).elements()).toHaveLength(0);
  });

  test('says needs review, and warns the day is spent regardless', async () => {
    await renderDraft({ instant: false });

    await expect.element(page.getByText('Free · needs review')).toBeInTheDocument();
    await expect.element(page.getByText(/spent even if they decline/)).toBeInTheDocument();
  });

  test('offers no choice at all where there is no free offer', async () => {
    await renderDraft(null);

    expect(page.getByText(/^Free ·/).elements()).toHaveLength(0);
    expect(page.getByRole('button', { name: 'Place free' }).elements()).toHaveLength(0);
  });

  /**
   * No proceeds to split on a free placement, so the share caption must not
   * appear — it is a claim about money that does not move, and PR 3's accept
   * reward is a separate mechanism not derived from this split.
   */
  test('claims no payout while free is selected', async () => {
    await renderDraft({ instant: true }, { ownerShare: 1 });

    expect(page.getByText(/proceeds go to/).elements()).toHaveLength(0);
  });

  test('names the payout on the paid option', async () => {
    await renderDraft(null, { ownerShare: 1 });

    await expect.element(page.getByText(/proceeds go to/)).toBeInTheDocument();
  });
});
