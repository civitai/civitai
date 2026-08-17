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
          fetch: async () => mocks.visibility,
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
    await openAndPick();
    // The re-read the handler makes after the refusal now says the slots went.
    mocks.visibility = { ...mocks.visibility, freeSlotsRemaining: 0 };

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
