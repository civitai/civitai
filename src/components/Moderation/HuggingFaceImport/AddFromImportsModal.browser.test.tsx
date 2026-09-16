import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * Pins what only this file can see: `adoptFiles` receives the ids `attach` CREATED, after the
 * version query is refreshed. Import ids are also `number[]`, so the types cannot catch a swap.
 */

const calls = vi.hoisted(() => [] as string[]);
const listed = vi.hoisted(() => ({ rows: [] as unknown[] }));
const { mockAdoptFiles, mockMutateAsync, mockSuccess, mockError } = vi.hoisted(() => ({
  mockAdoptFiles: vi.fn(),
  mockMutateAsync: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
}));

const allImports = [
  {
    id: 11,
    groupName: 'flux-krea',
    repo: 'black-forest-labs/FLUX.1-Krea-dev',
    revision: 'aaaaaaa1',
    filename: 'flux1-krea-dev.safetensors',
    sizeBytes: 1000,
    suggestedType: null,
    createdAt: new Date('2026-09-01'),
  },
  {
    id: 12,
    groupName: 'flux-krea',
    repo: 'black-forest-labs/FLUX.1-Krea-dev',
    revision: 'aaaaaaa1',
    filename: 'ae.safetensors',
    sizeBytes: 500,
    suggestedType: 'VAE',
    createdAt: new Date('2026-09-01'),
  },
];

const invalidate = (name: string) => () => {
  calls.push(`invalidate:${name}`);
  return Promise.resolve();
};

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      modelVersion: { getByIdForEdit: { invalidate: invalidate('getByIdForEdit') } },
      huggingFaceImport: {
        getAll: { invalidate: invalidate('getAll') },
        getCounts: { invalidate: invalidate('getCounts') },
      },
    }),
    huggingFaceImport: {
      getAll: { useQuery: () => ({ data: listed.rows, isLoading: false }) },
      attach: { useMutation: () => ({ mutateAsync: mockMutateAsync }) },
    },
  },
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showSuccessNotification: mockSuccess,
  showErrorNotification: mockError,
}));

import AddFromImportsModal from '~/components/Moderation/HuggingFaceImport/AddFromImportsModal';

/** Opened the way the button opens it — through the store, stacked above whatever is showing. */
async function openPicker() {
  renderWithProviders(<DialogProvider />);
  dialogStore.trigger({
    component: AddFromImportsModal,
    props: { modelVersionId: 42, modelType: 'Checkpoint', adoptFiles: mockAdoptFiles },
  });
  await expect.element(page.getByText('Add from Hugging Face imports')).toBeVisible();
}

async function pickType(filename: string, label: string) {
  const row = page.getByText(filename).element().parentElement as HTMLElement;
  (row.querySelector('input') as HTMLInputElement).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

beforeEach(() => {
  useDialogStore.getState().closeAll();
  calls.length = 0;
  listed.rows = allImports;
  mockAdoptFiles.mockReset().mockImplementation(async (ids: number[]) => {
    calls.push(`adopt:${ids.join(',')}`);
  });
  mockMutateAsync.mockReset().mockImplementation(async ({ id }: { id: number }) => {
    calls.push(`attach:${id}`);
    return { modelFileId: 900 + id };
  });
  mockSuccess.mockReset();
  mockError.mockReset();
});

describe('AddFromImportsModal', () => {
  test('adopts the CREATED file ids, after the version query is refreshed', async () => {
    await openPicker();

    await pickType('flux1-krea-dev.safetensors', 'Checkpoint');
    await pickType('ae.safetensors', 'VAE');
    await page.getByRole('button', { name: 'Attach 2' }).click();

    await expect.poll(() => mockSuccess.mock.calls.length).toBe(1);
    expect(mockMutateAsync.mock.calls.map(([input]) => input)).toEqual([
      { id: 11, modelVersionId: 42, type: 'Model' },
      { id: 12, modelVersionId: 42, type: 'VAE' },
    ]);
    expect(mockAdoptFiles).toHaveBeenCalledTimes(1);
    expect(mockAdoptFiles).toHaveBeenCalledWith([911, 912]);
    // Adopting before the refresh would read the cached version, which lacks the new files.
    expect(calls.indexOf('adopt:911,912')).toBeGreaterThan(
      calls.indexOf('invalidate:getByIdForEdit')
    );
  });

  test('attaches nothing until a type is picked — no row is pre-selected', async () => {
    await openPicker();

    // The VAE row carries a suggestion; it must stay a hint, not a selection.
    await expect.element(page.getByPlaceholder('Suggested: VAE')).toBeVisible();
    await expect.element(page.getByRole('button', { name: /^Attach/ })).toBeDisabled();
  });

  test('cannot be clicked again while a batch is running', async () => {
    let release!: () => void;
    mockMutateAsync.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ modelFileId: 911 })))
    );
    await openPicker();

    await pickType('flux1-krea-dev.safetensors', 'Checkpoint');
    await page.getByRole('button', { name: 'Attach 1' }).click();
    await expect.poll(() => mockMutateAsync.mock.calls.length).toBe(1);

    // Mid-flight the button is loading and the rows are frozen, so a second click cannot re-submit.
    await expect.element(page.getByRole('button', { name: /^Attach/ })).toBeDisabled();
    expect((page.getByPlaceholder('Pick a file type').element() as HTMLInputElement).disabled).toBe(
      true
    );

    release();
    await expect.poll(() => mockSuccess.mock.calls.length).toBe(1);
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
  });

  test('drops a row from the selection once it leaves the list', async () => {
    // 11 attaches and drops out of the refreshed list; 12 fails, so the modal stays open with both
    // still selected in state. Counting 11 would re-attach it on the next click.
    mockMutateAsync.mockImplementation(async ({ id }: { id: number }) => {
      if (id === 12) throw new Error('Scan submission failed.');
      listed.rows = allImports.filter((row) => row.id !== 11);
      return { modelFileId: 911 };
    });
    await openPicker();

    await pickType('flux1-krea-dev.safetensors', 'Checkpoint');
    await pickType('ae.safetensors', 'VAE');
    await page.getByRole('button', { name: 'Attach 2' }).click();
    await expect.poll(() => mockError.mock.calls.length).toBe(1);

    await expect.element(page.getByRole('button', { name: 'Attach 1' })).toBeVisible();
  });

  test('keeps every attach failure when the refresh also fails', async () => {
    mockMutateAsync.mockImplementation(async ({ id }: { id: number }) => {
      if (id === 12) throw new Error('Created model file 555, but this import was attached first.');
      return { modelFileId: 900 + id };
    });
    mockAdoptFiles.mockRejectedValue(new Error('refresh failed'));
    await openPicker();

    await pickType('flux1-krea-dev.safetensors', 'Checkpoint');
    await pickType('ae.safetensors', 'VAE');
    await page.getByRole('button', { name: 'Attach 2' }).click();

    await expect.poll(() => mockError.mock.calls.length).toBe(1);
    const messages = (mockError.mock.calls[0][0].error as { message: string }[]).map(
      (error) => error.message
    );
    // The lost-claim message is the only place file 555 is ever named.
    expect(messages).toContain('Created model file 555, but this import was attached first.');
    expect(messages).toContain('refresh failed');
  });
});
