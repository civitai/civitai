import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as CosmeticShopUtil from '~/components/CosmeticShop/cosmetic-shop.util';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { resolveTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import { stickerArtworkStyle } from '~/components/Sticker/placement-appearance';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';

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
 * absolutely positioned inside the rotated draft, and the measured failure was a
 * negative **x**. Nothing in the component moves it horizontally —
 * `shouldFlipPlaceButton` is vertical only, as `DraftSticker.tsx` says where it is
 * used — so the flip is not the cause. Beyond that the mechanism is unestablished,
 * and it is not the reason for the exemption either way.)
 *
 * 🔴 **Five things end this exemption**, and any one of them means going back to a
 * locator click and solving the reachability properly:
 * 1. `BuzzTransactionButton` stops being mocked.
 * 2. Either helper is used to assert reachability, or enabled/disabled state,
 *    rather than the payload.
 * 3. The cluster gains an overlay, so a press could be intercepted.
 * 4. The pattern is copied into another file as habit.
 * 5. **The paid control acquires an inert state.** The real button is
 *    `disabled={… || !!error || isLoadingBalance || loading}` and routes its click
 *    through `conditionalPerformTransaction`, which can open the buy-Buzz flow
 *    INSTEAD of calling the handler. The stub honours none of that, and the draft
 *    already passes `loading={place.isPending}` — so the moment an error or
 *    disabled condition is added, or a test renders with `isPending: true`, a DOM
 *    press fires a handler a real user could not fire and both payload tests
 *    assert a send that cannot happen.
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
 * The free option is a price; the review is a property of the SPACE.
 *
 * 🔴 The option used to read `Free · instant` / `Free · needs review` beside a
 * plain `100 Buzz`, which says the paid one does not get reviewed — and on a
 * review space both do. Justin, on seeing it: "it makes it seem like the other
 * one's not going to need review". So the segment says `Free`, and what a
 * decline costs is said once, under the button that spends the placement, where
 * it applies to whichever option is selected.
 */
describe('the free option is a price, not a process', () => {
  test('says nothing about review on an auto-accept space, and warns of nothing', async () => {
    await renderDraft({ instant: true });

    // `exact`, because "Place free" on the button below also contains the word.
    await expect.element(page.getByText('Free', { exact: true })).toBeInTheDocument();
    // Nothing to warn about: an auto space places it live, so there is no
    // decline that could take the day with it.
    expect(page.getByText(/Spends your free placement/).elements()).toHaveLength(0);
  });

  test('says the same on a review space, and warns under the button instead', async () => {
    await renderDraft({ instant: false });

    await expect.element(page.getByText('Free', { exact: true })).toBeInTheDocument();
    // The label does not carry the mode; this line does, and it says the thing
    // that actually costs the reader something.
    await expect.element(page.getByText(/Spends your free placement/)).toBeInTheDocument();
  });

  test('offers no choice at all where there is no free offer', async () => {
    await renderDraft(null);

    expect(page.getByRole('button', { name: 'Place free' }).elements()).toHaveLength(0);
    expect(page.getByText(/Spends your free placement/).elements()).toHaveLength(0);
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

/**
 * The glyph on the flip control has to name the axis the transform mirrors
 * across, and Tabler's names run the other way: `IconFlipHorizontal` draws a
 * HORIZONTAL mirror line, which reads as a top-to-bottom flip. Picking the icon
 * by its name is how this control ended up showing the wrong one twice.
 *
 * So this asserts the geometry rather than the icon's name or its path data: the
 * mirror line is the one sub-path of the glyph that is a straight line, and a
 * vertical line has zero width. That survives a Tabler version bump redrawing
 * the arrows, and still fails if someone swaps the pair back.
 */
describe('the flip control draws the axis it mirrors across', () => {
  test('mirror line is vertical, matching the artwork transform', async () => {
    // The claim the glyph has to agree with. `scaleX(-1)` mirrors left-to-right,
    // i.e. across a VERTICAL axis — read it here rather than restating it, so
    // changing the transform to `scaleY` fails this test instead of silently
    // making the icon wrong again.
    expect(stickerArtworkStyle({ flip: true, opacity: 1 }).transform).toBe('scaleX(-1)');

    await renderDraft(null);

    const button = (await page
      .getByRole('button', { name: 'Flip this sticker' })
      .element()) as HTMLElement;
    const boxes = Array.from(button.querySelectorAll('path')).map((path) => path.getBBox());

    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.some((box) => box.width === 0 && box.height > 0)).toBe(true);
    expect(boxes.some((box) => box.height === 0 && box.width > 0)).toBe(false);
  });
});

/**
 * The duplicate control, and what it is allowed to do.
 *
 * Placement is charged, so the button's whole safety argument is that it does
 * not place anything: it asks the host for another draft and nothing else. What
 * is asserted is both halves of that — the handler is called with this draft's
 * id, AND nothing reached the placement mutation.
 */
/**
 * Which of the two control containers rendered.
 *
 * Asserting the button EXISTS cannot tell the branches apart — both render an
 * identically named control — so a test meaning to cover the pill would pass on
 * the cluster and the uncovered branch would stay uncovered. The shape differs
 * and is stable: in the pill, remove lives in its own container; in the buy
 * cluster, remove is a sibling of duplicate.
 */
const removeIsSiblingOfDuplicate = async () => {
  const duplicate = (await page
    .getByRole('button', { name: 'Duplicate this sticker' })
    .element()) as HTMLElement;
  const remove = (await page
    .getByRole('button', { name: 'Remove this sticker' })
    .element()) as HTMLElement;

  return duplicate.parentElement?.contains(remove) ?? false;
};

describe('the duplicate control', () => {
  /**
   * ⚠️ THE NARROW FIXTURE PUTS THE CONTROL IN THE BUY CLUSTER, NOT THE PILL.
   *
   * `panelsInside` needs the sticker to be at least 124px wide; the shared
   * fixture is 0.25 of a 380px container, so 95px — the controls go to the buy
   * cluster, which this file documents as landing at a negative x here. That is
   * why this one is pressed through the DOM. The test below covers the pill
   * branch with a wide draft and an ordinary locator click, so both render paths
   * are exercised rather than one being described and neither checked.
   */
  test('asks the host for another copy, and places nothing', async () => {
    const duplicated: string[] = [];

    renderWithProviders(
      <div style={{ position: 'relative', width: 380, height: 600 }}>
        <DraftSticker
          draft={draft}
          art={art}
          selected
          dressed={resolveTreatment({ treatment: 'none', surface: 'detail', isPending: false })}
          price={PRICE}
          freeOffer={null}
          ownerShare={undefined}
          ownerUsername="creator"
          onGesture={() => true}
          onDuplicate={(id) => {
            duplicated.push(id);
            return 'copy-of-the-draft';
          }}
        />
      </div>
    );

    const locator = page.getByRole('button', { name: 'Duplicate this sticker' });
    await expect.element(locator).toBeInTheDocument();
    ((await locator.element()) as HTMLElement).click();

    expect(duplicated).toEqual([draft.id]);
    // Pins WHICH branch this covers: at 95px the controls are in the buy
    // cluster, where remove sits beside duplicate.
    expect(await removeIsSiblingOfDuplicate()).toBe(true);
    // 🔴 The half that matters for money: duplicating must not reach the
    // placement mutation.
    expect(placed).toHaveLength(0);

    // 🔴 THE POSITIVE CONTROL, IN THE SAME RENDER. Without it the zero above is
    // an absence measured by an instrument nothing proved was live — a broken
    // mock would certify "charges nothing" forever.
    await pressPaid();
    expect(placed).toHaveLength(1);
  });

  /**
   * The OTHER render path. Below 124px of sticker width the controls go to the
   * buy cluster; above it they go to the pill. Both have to actually render the
   * duplicate control, and only one of them was being exercised — deleting
   * `{duplicateControl}` from the pill left every test green.
   *
   * ⚠️ What this does NOT assert is reachability. Measured in this harness, the
   * control sits at x = -95 in the pill branch and x = -73 in the cluster
   * branch: the whole draft renders at negative coordinates here, so no locator
   * click succeeds on either path and a passing "it is clickable" test would be
   * a fiction. Presence is what this harness can honestly check.
   */
  test('renders in the pill branch as well as the buy cluster', async () => {
    renderWithProviders(
      <div style={{ position: 'relative', width: 380, height: 600 }}>
        <DraftSticker
          // 0.5 of 380 is 190px, past the 124px threshold, so the controls sit
          // in the pill above the sticker rather than in the buy cluster.
          draft={{ ...draft, scale: 0.5, y: 0.5 }}
          art={art}
          selected
          dressed={resolveTreatment({ treatment: 'none', surface: 'detail', isPending: false })}
          price={PRICE}
          freeOffer={null}
          ownerShare={undefined}
          ownerUsername="creator"
          onGesture={() => true}
          onDuplicate={() => null}
        />
      </div>
    );

    await expect
      .element(page.getByRole('button', { name: 'Duplicate this sticker' }))
      .toBeInTheDocument();

    // 🔴 The assertion that makes this a DIFFERENT test rather than a second
    // copy of the one above. Both branches render a button of the same name, so
    // presence alone is satisfied by the cluster; the pill keeps remove in its
    // own container.
    expect(await removeIsSiblingOfDuplicate()).toBe(false);
  });

  /**
   * Absent rather than disabled where the host supplies no handler: a control
   * that cannot act is a question the placer answers by pressing it.
   */
  test('is not rendered at all without a handler', async () => {
    await renderDraft(null);

    expect(page.getByRole('button', { name: 'Duplicate this sticker' }).elements()).toHaveLength(0);
  });
});

/**
 * Alt-drag: leave a copy behind and drag the new one, the way a photo editor
 * does it. Justin asked for it alongside the button.
 *
 * The property that matters is WHICH sticker the drag then moves. Dragging the
 * original would leave the copy stranded under the pointer and move the thing
 * the placer was trying to keep in place — a duplicate that appears to do the
 * opposite of what it says.
 */
describe('alt-dragging a draft', () => {
  const dragBody = (options: PointerEventInit = {}) => {
    // The move handler is on the positioned wrapper — the element carrying the
    // draft's own left/top — rather than on the artwork inside it.
    const artwork = document.querySelector('img[alt=":star:"], img[alt="Star"]');
    const body = artwork?.closest('[style*="touch-action"]') as HTMLElement | null;

    body?.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        ...options,
      })
    );

    return body;
  };

  const renderForDrag = async (onDuplicate: (id: string) => string | null) => {
    const gestures: { draftId: string }[] = [];

    renderWithProviders(
      <div data-drag-host style={{ position: 'relative', width: 380, height: 600 }}>
        <DraftSticker
          draft={draft}
          art={art}
          selected
          dressed={resolveTreatment({ treatment: 'none', surface: 'detail', isPending: false })}
          price={PRICE}
          freeOffer={null}
          ownerShare={undefined}
          ownerUsername="creator"
          onGesture={(gesture) => {
            gestures.push(gesture);
            return true;
          }}
          onDuplicate={onDuplicate}
        />
      </div>
    );

    await expect.element(page.getByRole('button').first()).toBeInTheDocument();

    // 🔴 WITHOUT THIS THE HANDLER RETURNS AT ITS FIRST LINE. A press is
    // translated into a fraction of the surface the placement session
    // registered, and with no surface there is no fraction and no gesture — so
    // every assertion below would pass or fail for the wrong reason. The app
    // registers it from `ImageStickerOverlay`; here the host stands in for it.
    const store = useStickerPlacementDraftStore.getState();
    store.open(IMAGE_ID);
    store.setSurface(document.querySelector('[data-drag-host]') as HTMLElement);

    return gestures;
  };

  test('duplicates first, then drags the COPY', async () => {
    const duplicated: string[] = [];
    const gestures = await renderForDrag((id) => {
      duplicated.push(id);
      return 'the-copy';
    });

    expect(dragBody({ altKey: true })).not.toBeNull();

    expect(duplicated).toEqual([draft.id]);
    expect(gestures.at(-1)?.draftId).toBe('the-copy');
  });

  test('an ordinary drag duplicates nothing and moves the original', async () => {
    const duplicated: string[] = [];
    const gestures = await renderForDrag((id) => {
      duplicated.push(id);
      return 'the-copy';
    });

    dragBody();

    expect(duplicated).toEqual([]);
    expect(gestures.at(-1)?.draftId).toBe(draft.id);
  });

  /**
   * The host may refuse — there is no handler on a surface that does not offer
   * duplication. Alt then has to fall back to an ordinary drag rather than
   * dropping the gesture on the floor.
   */
  test('falls back to moving the original when the copy is refused', async () => {
    const gestures = await renderForDrag(() => null);

    dragBody({ altKey: true });

    expect(gestures.at(-1)?.draftId).toBe(draft.id);
  });
});

/**
 * 🔴 THE KEY IS RELEASED WHEN THE PURCHASE RESOLVES.
 *
 * The server's idempotency check reads a persisted purchase row and THROWS, so a
 * key held past success refuses the next legitimate purchase of the same pack in
 * that session — "this purchase has already been completed" — and the sticker
 * stays unbuyable until a reload. Buy a refill pack, spend it, want another:
 * that flow predates this feature and has to keep working.
 *
 * Asserted at the call site rather than on the store, because the store's own
 * test cannot see whether anything calls it.
 */
describe('the pack purchase key across one session', () => {
  const gated: StickerDraft = {
    ...draft,
    purchase: {
      refill: true,
      pack: { shopItemId: 7, unitAmount: 500, acceptsBlue: false, uses: 1 },
      creatorUsername: 'maker',
    },
  };

  test('is released once the purchase resolves, so the same pack can be bought again', async () => {
    renderWithProviders(
      <div style={{ position: 'relative', width: 380, height: 600 }}>
        <DraftSticker
          draft={gated}
          art={art}
          selected
          dressed={resolveTreatment({ treatment: 'none', surface: 'detail', isPending: false })}
          price={PRICE}
          freeOffer={null}
          ownerShare={undefined}
          ownerUsername="creator"
          onGesture={() => true}
        />
      </div>
    );

    const buy = page.getByRole('button', { name: 'Buy another pack' });
    await expect.element(buy).toBeInTheDocument();

    const store = useStickerPlacementDraftStore.getState();
    const before = store.packPurchaseKey(gated.cosmeticId);

    ((await buy.element()) as HTMLElement).click();

    // The handler is async — it invalidates a query before releasing the key.
    await vi.waitFor(() =>
      expect(useStickerPlacementDraftStore.getState().packPurchaseKey(gated.cosmeticId)).not.toBe(
        before
      )
    );
  });
});
