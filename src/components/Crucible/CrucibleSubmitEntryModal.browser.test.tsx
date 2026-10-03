import { beforeEach, describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcModule from '~/utils/trpc';
import type * as CurrentUserModule from '~/hooks/useCurrentUser';
import type * as DialogProviderModule from '~/components/Dialog/DialogProvider';
import type * as MediaUploadModule from '~/hooks/useMediaUpload';
import type * as GeneratorPickerModule from '~/components/EntrySubmit/GeneratorMediaPicker';
import type * as BuzzButtonModule from '~/components/Buzz/BuzzTransactionButton';
import type * as EdgeMediaModule from '~/components/EdgeMedia/EdgeMedia';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

/**
 * What a selection costs decides which button submits it: a charge goes through
 * `BuzzTransactionButton`, a free entry through a plain button. Inverted, a free entry asks the
 * entrant for Buzz the server never takes — or a paid one skips the balance check and purchase
 * prompt. The cost math has unit tests; this covers its wiring into the footer.
 */

const mocks = vi.hoisted(() => ({
  images: [] as { id: number }[],
  reasonsById: {} as Record<number, string[]>,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: {
      useUtils: () => ({}),
      image: {
        getMyImages: {
          useInfiniteQuery: () => ({
            data: { pages: [{ items: mocks.images }] },
            isLoading: false,
            hasNextPage: false,
            fetchNextPage: vi.fn(),
            isFetchingNextPage: false,
          }),
        },
      },
      post: { addImage: { useMutation: mutation } },
      crucible: {
        createEntryPost: { useMutation: mutation },
        submitEntry: { useMutation: mutation },
        getMinVotesToPlace: { useQuery: () => ({ data: undefined }) },
        getById: { useQuery: () => ({ data: { viewerEntries: [] } }) },
        checkEntryEligibility: {
          useQuery: () => ({
            data: mocks.images.map(({ id }) => ({
              imageId: id,
              reasons: mocks.reasonsById[id] ?? [],
            })),
          }),
        },
      },
    },
  };
});

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUserModule>()),
  useCurrentUser: () => ({ id: 42, muted: false }),
}));

vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogProviderModule>()),
  useDialogContext: () => ({ opened: true, onClose: vi.fn() }),
}));

vi.mock('~/hooks/useMediaUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaUploadModule>()),
  useMediaUpload: () => ({ upload: vi.fn(), files: [], progress: 0, canAdd: true, loading: false }),
}));

vi.mock('~/components/EntrySubmit/GeneratorMediaPicker', async (importOriginal) => ({
  ...(await importOriginal<typeof GeneratorPickerModule>()),
  GeneratorMediaPicker: () => null,
}));

vi.mock('~/components/Buzz/BuzzTransactionButton', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzButtonModule>()),
  BuzzTransactionButton: ({ buzzAmount, label }: { buzzAmount: number; label: string }) => (
    <button type="button" data-testid="buzz-transaction" data-amount={buzzAmount}>
      {label}
    </button>
  ),
}));

vi.mock('~/components/EdgeMedia/EdgeMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof EdgeMediaModule>()),
  EdgeMedia: ({ src }: { src: string }) => <span data-testid="entry-media" data-src={src} />,
}));

const { default: CrucibleSubmitEntryModal } = await import(
  '~/components/Crucible/CrucibleSubmitEntryModal'
);

const image = (id: number) => ({
  id,
  url: `image-${id}`,
  nsfwLevel: 1,
  type: MediaType.image,
  metadata: null,
  meta: null,
  ingestion: ImageIngestionStatus.Scanned,
  createdAt: new Date(),
});

const renderModal = ({
  currentEntryCount = 0,
  freeEntriesPerUser = 1,
}: { currentEntryCount?: number; freeEntriesPerUser?: number } = {}) =>
  renderWithProviders(
    <CrucibleSubmitEntryModal
      crucibleId={1}
      crucibleName="Free first"
      entryFee={50}
      entryLimit={3}
      freeEntriesPerUser={freeEntriesPerUser}
      nsfwLevel={1}
      contentType={MediaType.image}
      currentEntryCount={currentEntryCount}
    />
  );

const select = async (...ids: number[]) => {
  await vi.waitFor(() =>
    expect(document.querySelectorAll('[data-testid="entry-media"]').length).toBe(
      mocks.images.length
    )
  );
  for (const id of ids)
    document
      .querySelector<HTMLElement>(`[data-testid="entry-media"][data-src="image-${id}"]`)!
      .closest<HTMLElement>('.group')!
      .click();
};

const buzzButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="buzz-transaction"]');
const plainSubmit = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.startsWith('Submit') && button !== buzzButton()
  );

beforeEach(() => {
  mocks.images = [image(1), image(2)];
  mocks.reasonsById = {};
});

describe('CrucibleSubmitEntryModal — free entries', () => {
  test('a first entry within the free ones submits without a charge', async () => {
    renderModal();
    await select(1);

    await vi.waitFor(() => expect(plainSubmit()?.textContent).toContain('Submit 1 Entry'));
    expect(buzzButton()).toBeNull();
  });

  test('charges only the entries beyond the free ones', async () => {
    renderModal();
    await select(1, 2);

    await vi.waitFor(() => expect(buzzButton()?.dataset.amount).toBe('50'));
  });

  test('charges the fee once the free entry is used', async () => {
    renderModal({ currentEntryCount: 1 });
    await select(1);

    await vi.waitFor(() => expect(buzzButton()?.dataset.amount).toBe('50'));
  });

  test('charges every entry when the crucible offers none free', async () => {
    renderModal({ freeEntriesPerUser: 0 });
    await select(1);

    await vi.waitFor(() => expect(buzzButton()?.dataset.amount).toBe('50'));
  });

  test('tells the entrant which entries are free', async () => {
    renderModal();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('First entry free, then 50 Buzz per entry')
    );
  });
});

describe('CrucibleSubmitEntryModal — base model requirement', () => {
  test('selects only the image the server says used an allowed base model', async () => {
    mocks.reasonsById = { 1: ['wrong-base-model'] };
    renderWithProviders(
      <CrucibleSubmitEntryModal
        crucibleId={1}
        crucibleName="H3 only"
        entryFee={50}
        entryLimit={3}
        nsfwLevel={1}
        contentType={MediaType.image}
        currentEntryCount={0}
        allowedBaseModels={['MiniMax H3']}
      />
    );
    await select(1, 2);

    await vi.waitFor(() => expect(buzzButton()?.textContent).toContain('Submit 1 Entry'));
    expect(buzzButton()?.dataset.amount).toBe('50');
  });
});
