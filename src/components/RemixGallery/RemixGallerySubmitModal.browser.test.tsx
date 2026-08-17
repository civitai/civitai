import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';

/**
 * The three branches of the submit card that decide what somebody is CHARGED or
 * TOLD, and that no other layer can see.
 *
 * The card's policy lives in pure functions with their own unit tests — the
 * refusal ladder, whether a refusal is explainable, whether recommending Buzz is
 * honest. This file covers only the wiring between those answers and the DOM,
 * because each branch below is a single token whose inversion is silent
 * everywhere else:
 *
 * 1. The submit button. Inverted, a submission the user chose to make FREE goes
 *    through `BuzzTransactionButton` carrying `expectedPrice` — a spend the user
 *    did not consent to, with nothing red at any layer.
 * 2. The unexplained-refusal notification. Inverted, the server's own refusal
 *    reaches nobody: a blocked or suspended submitter presses Submit and sees
 *    NOTHING. That is exactly the behaviour the refusal split removed.
 * 3. The decline-fee note. Shown on a free submission it describes escrow that
 *    never existed — "the creator keeps N Buzz and the rest comes back" about
 *    money nobody paid.
 *
 * `toHaveBeenCalledTimes(1)` sits beside every `toHaveBeenCalledWith`, so a
 * doubled submit cannot pass as a correct one.
 */

const HOST = 74;
const MINE = 85;
const PRICE = 700;

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  showError: vi.fn(),
  visibility: {} as Record<string, unknown>,
  /** What the post-refusal re-read returns. Separate from the query's answer on
   *  purpose: reassigning one object between render and click had the same fake
   *  backing both, which holds today and is one added effect away from
   *  unmounting the button mid-click and hanging to the 15s ceiling. */
  nextVisibility: null as Record<string, unknown> | null,
  eligibility: {} as Record<string, unknown>,
  /** When set, the mutation refuses with this message. */
  refuseWith: '' as string,
}));

// The real module spread first, so a new export does not silently become
// `undefined` for every importer in this test's graph — which fails the whole
// file to load and collects zero tests without one failing assertion.
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      placement: {
        invalidate: vi.fn(),
        getRemixGalleryVisibility: {
          fetch: async () => mocks.nextVisibility ?? mocks.visibility,
          invalidate: vi.fn(),
        },
        getRemixGalleryFreeEligibility: { fetch: async () => mocks.eligibility },
      },
    }),
    placement: {
      getRemixGalleryVisibility: { useQuery: () => ({ data: mocks.visibility, isError: false }) },
      getRemixGalleryFreeEligibility: { useQuery: () => ({ data: mocks.eligibility }) },
      submitToRemixGallery: {
        // Drives the real `onError` rather than exposing it, so the branch under
        // test is reached the way the mutation reaches it.
        useMutation: (opts: { onError: (e: { message: string }) => void | Promise<void> }) => ({
          mutate: (input: unknown) => {
            mocks.submit(input);
            if (mocks.refuseWith) return opts.onError({ message: mocks.refuseWith });
          },
          isPending: false,
        }),
      },
    },
  },
}));

vi.mock('~/utils/notifications', () => ({
  showErrorNotification: (args: unknown) => mocks.showError(args),
  showSuccessNotification: vi.fn(),
}));

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn() }),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 52 }) }));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));

vi.mock('~/components/Image/image.utils', () => ({
  useQueryImages: () => ({
    images: [{ id: MINE, nsfwLevel: 1, url: 'x', width: 1, height: 1, type: 'image' }],
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isRefetching: false,
  }),
}));

// Stubbed to a plain button so the test drives the real branch rather than
// Mantine's internals — and so a Buzz submit is distinguishable from a free one
// by which testid appears at all.
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: ({
    label,
    onPerformTransaction,
    disabled,
  }: {
    label: string;
    onPerformTransaction: () => void;
    disabled?: boolean;
  }) => (
    <button data-testid="buzz-submit" disabled={disabled} onClick={onPerformTransaction}>
      {label}
    </button>
  ),
}));

vi.mock('~/components/CardTemplates/AspectRatioImageCard', () => ({
  AspectRatioImageCard: ({ image, onClick }: { image: { id: number }; onClick: () => void }) => (
    <button data-testid={`pick-${image.id}`} onClick={onClick}>
      pick
    </button>
  ),
}));
vi.mock('~/components/InView/InViewLoader', () => ({ InViewLoader: () => null }));

const { RemixGallerySubmitModal } = await import('./RemixGallerySubmitModal');

/** Everything set so the free option is genuinely on offer. */
const freeIsOffered = () => {
  mocks.visibility = {
    open: true,
    price: PRICE,
    declineFee: 210,
    freeSlots: 2,
    freeSlotsRemaining: 1,
    maxSubmissionLevel: 32,
    ownerId: 41,
    viewerPending: [],
    pendingCount: 0,
  };
  mocks.eligibility = {
    verifiedImageIds: [MINE],
    usedHere: false,
    allowance: { used: 0, remaining: 1, resetsAt: new Date('2026-03-04') },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  freeIsOffered();
  mocks.nextVisibility = null;
  mocks.refuseWith = '';
});

const openAndPick = async () => {
  renderWithProviders(<RemixGallerySubmitModal hostImageId={HOST} />);
  await page.getByTestId(`pick-${MINE}`).click();
};

describe('the submit button', () => {
  test('a free submission never goes through the Buzz path', async () => {
    // 🔴 The spend-without-consent branch. Inverted, this sends `expectedPrice`
    // through `onPerformTransaction` for a submission the user chose to make
    // free, and nothing at any other layer notices.
    await openAndPick();
    await page.getByRole('button', { name: /submit for free/i }).click();

    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledWith({ hostImageId: HOST, imageId: MINE, free: true });
    // The payload carries no price, and the Buzz button is not even mounted.
    expect(mocks.submit.mock.calls[0][0]).not.toHaveProperty('expectedPrice');
    await expect.element(page.getByTestId('buzz-submit')).not.toBeInTheDocument();
  });

  test('the paid submission still carries the price it was shown', async () => {
    await openAndPick();
    await page.getByRole('radio', { name: new RegExp(`${PRICE} Buzz`) }).click();
    await page.getByTestId('buzz-submit').click();

    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledWith({
      hostImageId: HOST,
      imageId: MINE,
      expectedPrice: PRICE,
    });
  });
});

describe('a refused free submission', () => {
  const SERVER_PROSE =
    'remix gallery: free submissions are for remixes made from this image on-site';

  test('surfaces the server’s own refusal when a re-read cannot explain it', async () => {
    // 🔴 Invert the guard and this reaches nobody: a blocked or suspended
    // submitter presses Submit and sees NOTHING at all. The re-read below still
    // reports free as available, so the refusal was not about capacity.
    mocks.refuseWith = SERVER_PROSE;
    await openAndPick();
    await page.getByRole('button', { name: /submit for free/i }).click();

    await vi.waitFor(() => expect(mocks.showError).toHaveBeenCalledTimes(1));
    expect(mocks.showError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: SERVER_PROSE }) })
    );
  });

  test('explains a capacity refusal inline instead, with no error toast', async () => {
    mocks.refuseWith = 'remix gallery: the free slots on this one are taken';
    // The re-read the handler makes after the refusal says the slots went; the
    // query's own answer is untouched, so nothing re-renders mid-click.
    mocks.nextVisibility = { ...mocks.visibility, freeSlotsRemaining: 0 };
    await openAndPick();

    await page.getByRole('button', { name: /submit for free/i }).click();

    await expect.element(page.getByText(/all taken right now/i)).toBeInTheDocument();
    // An ordinary outcome with a next step, not an error.
    expect(mocks.showError).not.toHaveBeenCalled();
    // And never the server's raw wording.
    await expect
      .element(page.getByText(/free slots on this one are taken/i))
      .not.toBeInTheDocument();
  });
});

describe('a gallery that takes free submissions and refuses paid ones', () => {
  /**
   * 🔴 The fixture the rest of this file could not provide, and the reason both
   * of the previous round's fixes were invisible: every other case here prices
   * the gallery at 700 against a floor of 50, so `paidOpen` is always true and
   * the two conditions it separates are identical.
   *
   * The service holds free submissions to none of the price rules — there are
   * tests asserting an unpriced and a below-floor gallery accept free and refuse
   * paid — so this is a supported configuration, not an edge case.
   */
  const paidClosed = (price: number | null) => {
    mocks.visibility = { ...mocks.visibility, price };
    mocks.nextVisibility = { ...mocks.visibility, price, freeSlotsRemaining: 0 };
    mocks.refuseWith = 'remix gallery: the free slots on this one are taken';
  };

  test.each([
    ['unpriced', null],
    ['priced below the floor', 10],
  ])('does not offer Buzz as the alternative — %s', async (_label, price) => {
    paidClosed(price);
    await openAndPick();
    await page.getByRole('button', { name: /submit for free/i }).click();

    // Says the true thing rather than pointing at a button that is disabled
    // (unpriced) or that leads into a second refusal and a buy-Buzz prompt
    // (below the floor).
    await expect.element(page.getByText(/not taking paid submissions/i)).toBeInTheDocument();
    await expect.element(page.getByText(/still submit with Buzz/i)).not.toBeInTheDocument();

    // An explained refusal, so it stays inline — this is the assertion that dies
    // if the banner goes back to being keyed on `fallBackToPaid`, which is false
    // here while the refusal is still perfectly explainable.
    expect(mocks.showError).not.toHaveBeenCalled();
  });

  test('offers no paid submit button at all', async () => {
    paidClosed(null);
    await openAndPick();
    await page.getByRole('button', { name: /submit for free/i }).click();

    await expect.element(page.getByTestId('buzz-submit')).not.toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: /submit for free/i }))
      .toBeInTheDocument();
  });

  /**
   * ⚠️ What this file does NOT pin, stated so the pair above is not over-read.
   *
   * `submissionMethod`'s `paidOpen` rule — the one that stops the control
   * FALLING into paid when free stops being available — is not reachable from
   * here. In production the handler's `.fetch()` writes the query cache, so
   * `freeAvailable` drops and the rule fires; this file's `useQuery` mock is
   * static and does not model that write-through, so `freeAvailable` never
   * drops and both branches return the same answer.
   *
   * Measured, not assumed: deleting `if (!paidOpen) return 'free'` leaves all
   * nine tests here green and fails three in `remix-gallery.utils.test.ts`.
   * That rule is the unit file's to hold, and a faithful cache-writing mock is
   * the only thing that would move it here.
   */
});

describe('the decline-fee note', () => {
  test('is not shown while the free option is selected', async () => {
    // It describes escrow. A free submission puts none up, so this would tell a
    // submitter the creator keeps Buzz they never paid.
    await openAndPick();

    await expect.element(page.getByText(/creator keeps/i)).not.toBeInTheDocument();
  });

  test('is shown on the paid option, where it is true', async () => {
    await openAndPick();
    await page.getByRole('radio', { name: new RegExp(`${PRICE} Buzz`) }).click();

    await expect.element(page.getByText(/creator keeps 210 Buzz/i)).toBeInTheDocument();
  });
});
