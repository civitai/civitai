import { beforeEach, describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as NotificationsModule from '~/utils/notifications';
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
  images: [] as { id: number; [key: string]: unknown }[],
  myImagesInputs: [] as Record<string, unknown>[],
  createEntryPost: vi.fn(),
  upload: vi.fn(),
  downloadGeneratorImages: vi.fn(),
  submitEntry: vi.fn(),
  uploadOnComplete: undefined as undefined | ((props: unknown, context: unknown) => void),
  addImageOnSuccess: undefined as undefined | ((image: { id: number }) => void),
  showErrorNotification: vi.fn(),
  reasonsById: {} as Record<number, string[]>,
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showErrorNotification: mocks.showErrorNotification,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: {
      useUtils: () => ({ image: { getMyImages: { invalidate: vi.fn() } } }),
      image: {
        getMyImages: {
          useInfiniteQuery: (input: Record<string, unknown>) => {
            mocks.myImagesInputs.push(input);
            return {
              data: { pages: [{ items: mocks.images }] },
              isLoading: false,
              hasNextPage: false,
              fetchNextPage: vi.fn(),
              isFetchingNextPage: false,
            };
          },
        },
      },
      post: {
        addImage: {
          useMutation: (opts: { onSuccess: (image: { id: number }) => void }) => {
            mocks.addImageOnSuccess = opts.onSuccess;
            return mutation();
          },
        },
      },
      crucible: {
        createEntryPost: {
          useMutation: () => ({ ...mutation(), mutateAsync: mocks.createEntryPost }),
        },
        submitEntry: { useMutation: () => ({ ...mutation(), mutateAsync: mocks.submitEntry }) },
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
  useMediaUpload: ({ onComplete }: { onComplete: typeof mocks.uploadOnComplete }) => {
    mocks.uploadOnComplete = onComplete;
    return { upload: mocks.upload, files: [], progress: 0, canAdd: true, loading: false };
  },
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

vi.mock('~/utils/generator-import', () => ({
  downloadGeneratorImages: mocks.downloadGeneratorImages,
}));

const { useGeneratorSelectionStore } = await import(
  '~/components/EntrySubmit/GeneratorMediaPicker'
);
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
  mocks.myImagesInputs = [];
  mocks.upload.mockReset();
  mocks.submitEntry.mockReset().mockResolvedValue({ id: 1 });
  let postId = 300;
  mocks.createEntryPost.mockReset().mockImplementation(async () => ({ id: postId++ }));
  mocks.downloadGeneratorImages
    .mockReset()
    .mockImplementation(async (selected: unknown[]) =>
      selected.map((_, i) => ({ file: new File(['x'], `gen-${i}.png`) }))
    );
  useGeneratorSelectionStore.setState({ selected: [] });
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

describe('CrucibleSubmitEntryModal — from the generator', () => {
  const generated = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ url: `gen-${i}`, type: MediaType.image })) as never[];
  const openGeneratorTab = async () => {
    const tab = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (button) => button.textContent?.includes('From Generator')
      );
      expect(found).toBeTruthy();
      return found!;
    });
    tab.click();
  };

  test('submits straight to the crucible, never offering to add to a library', async () => {
    useGeneratorSelectionStore.setState({ selected: generated(1) });
    renderModal();
    await openGeneratorTab();

    await vi.waitFor(() => expect(plainSubmit()?.textContent).toContain('Submit 1 Entry'));
    expect(document.body.textContent).not.toMatch(/to library/i);
  });

  test('puts each generated image in its own unpublished post, and lists those drafts', async () => {
    useGeneratorSelectionStore.setState({ selected: generated(2) });
    renderModal({ freeEntriesPerUser: 3 });
    await openGeneratorTab();
    await vi.waitFor(() => expect(plainSubmit()?.textContent).toContain('Submit 2 Entries'));

    plainSubmit()!.click();

    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    expect(mocks.upload.mock.calls.map(([, context]) => context)).toEqual([
      { postId: 300 },
      { postId: 301 },
    ]);
    await vi.waitFor(() =>
      expect(mocks.myImagesInputs.at(-1)).toMatchObject({
        publishedOnly: true,
        draftPostIds: [300, 301],
      })
    );
  });
});

describe('CrucibleSubmitEntryModal — generator picks enter once scanned', () => {
  test('enters each picked image as soon as its scan settles, with no second click', async () => {
    useGeneratorSelectionStore.setState({
      selected: [{ url: 'gen-0', type: MediaType.image }] as never[],
    });
    mocks.images = [];
    const view = await renderModal();
    const tab = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (button) => button.textContent?.includes('From Generator')
      );
      expect(found).toBeTruthy();
      return found!;
    });
    tab.click();
    await vi.waitFor(() => expect(plainSubmit()?.textContent).toContain('Submit 1 Entry'));

    plainSubmit()!.click();
    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    expect(mocks.submitEntry).not.toHaveBeenCalled();

    // The upload lands and the image is added to its draft, still scanning.
    mocks.addImageOnSuccess!({ id: 77 });
    mocks.images = [{ ...image(77), ingestion: ImageIngestionStatus.Pending }];
    await view.rerender(
      <CrucibleSubmitEntryModal
        crucibleId={1}
        crucibleName="Free first"
        entryFee={50}
        entryLimit={3}
        freeEntriesPerUser={1}
        nsfwLevel={1}
        contentType={MediaType.image}
        currentEntryCount={0}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mocks.submitEntry, 'still scanning').not.toHaveBeenCalled();

    mocks.images = [image(77)];
    await view.rerender(
      <CrucibleSubmitEntryModal
        crucibleId={1}
        crucibleName="Free first"
        entryFee={50}
        entryLimit={3}
        freeEntriesPerUser={1}
        nsfwLevel={1}
        contentType={MediaType.image}
        currentEntryCount={0}
      />
    );

    await vi.waitFor(() =>
      expect(mocks.submitEntry).toHaveBeenCalledWith({ crucibleId: 1, imageId: 77 })
    );
    expect(mocks.submitEntry).toHaveBeenCalledTimes(1);
  });
});

describe('CrucibleSubmitEntryModal — a batch from the generator', () => {
  const props = {
    crucibleId: 1,
    crucibleName: 'Free first',
    entryFee: 50,
    entryLimit: 3,
    freeEntriesPerUser: 3,
    nsfwLevel: 1,
    contentType: MediaType.image,
    currentEntryCount: 0,
  };
  const startBatch = async () => {
    useGeneratorSelectionStore.setState({
      selected: [
        { url: 'gen-0', type: MediaType.image },
        { url: 'gen-1', type: MediaType.image },
      ] as never[],
    });
    mocks.images = [];
    const view = await renderWithProviders(<CrucibleSubmitEntryModal {...props} />);
    const tab = await vi.waitFor(() => {
      const found = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (button) => button.textContent?.includes('From Generator')
      );
      expect(found).toBeTruthy();
      return found!;
    });
    tab.click();
    await vi.waitFor(() => expect(plainSubmit()?.textContent).toContain('Submit 2 Entries'));
    plainSubmit()!.click();
    await vi.waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    return { rerender: () => view.rerender(<CrucibleSubmitEntryModal {...props} />) };
  };

  test('waits for every scan before entering any of them', async () => {
    const { rerender } = await startBatch();
    mocks.addImageOnSuccess!({ id: 77 });
    mocks.addImageOnSuccess!({ id: 78 });
    mocks.images = [image(77), { ...image(78), ingestion: ImageIngestionStatus.Pending }];
    await rerender();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(mocks.submitEntry, 'one scan is still pending').not.toHaveBeenCalled();

    mocks.images = [image(77), image(78)];
    await rerender();

    await vi.waitFor(() => expect(mocks.submitEntry).toHaveBeenCalledTimes(2));
    expect(mocks.submitEntry.mock.calls.map(([input]) => input.imageId).sort()).toEqual([77, 78]);
  });

  test('enters the rest when one upload is blocked', async () => {
    const { rerender } = await startBatch();
    mocks.uploadOnComplete!({ status: 'blocked', blockedFor: 'test' }, { postId: 301 });
    mocks.addImageOnSuccess!({ id: 77 });
    mocks.images = [image(77)];
    await rerender();

    await vi.waitFor(() =>
      expect(mocks.submitEntry).toHaveBeenCalledWith({ crucibleId: 1, imageId: 77 })
    );
    expect(mocks.submitEntry).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(mocks.showErrorNotification).toHaveBeenCalledWith(
        expect.objectContaining({ title: "1 couldn't be entered" })
      )
    );
  });
});
