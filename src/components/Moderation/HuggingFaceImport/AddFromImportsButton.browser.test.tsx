import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as FilesProviderModule from '~/components/Resource/FilesProvider';
import { renderWithProviders } from '../../../../test/component-setup';

const { mockOpen, mockAdoptFiles, user } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockAdoptFiles: vi.fn(),
  user: { current: { isModerator: true } as { isModerator: boolean } | null },
}));

// Pins the dialog-store route; the reason is on AddFromImportsButton.
vi.mock('~/components/Dialog/triggers/add-from-hugging-face-imports', () => ({
  openAddFromImportsModal: mockOpen,
}));
vi.mock('~/components/Resource/FilesProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FilesProviderModule>()),
  useFilesContext: () => ({ adoptFiles: mockAdoptFiles, modelType: 'Checkpoint' }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => user.current }));

import { AddFromImportsButton } from '~/components/Moderation/HuggingFaceImport/AddFromImportsButton';

describe('AddFromImportsButton', () => {
  test('opens the picker through the dialog store, with the provider handles', async () => {
    user.current = { isModerator: true };
    renderWithProviders(<AddFromImportsButton modelVersionId={42} />);

    await page.getByRole('button', { name: 'Add from Hugging Face imports' }).click();

    expect(mockOpen).toHaveBeenCalledWith({
      modelVersionId: 42,
      modelType: 'Checkpoint',
      adoptFiles: mockAdoptFiles,
    });
  });

  test('forwards the section scope, so the components button cannot mint weights', async () => {
    user.current = { isModerator: true };
    renderWithProviders(
      <AddFromImportsButton
        modelVersionId={42}
        types={['VAE', 'Text Encoder']}
        label="Add components from imports"
        title="Add components from Hugging Face imports"
      />
    );

    await page.getByRole('button', { name: 'Add components from imports' }).click();

    expect(mockOpen).toHaveBeenCalledWith({
      modelVersionId: 42,
      modelType: 'Checkpoint',
      adoptFiles: mockAdoptFiles,
      types: ['VAE', 'Text Encoder'],
      title: 'Add components from Hugging Face imports',
    });
  });

  test('renders nothing for a non-moderator', async () => {
    user.current = { isModerator: false };
    renderWithProviders(
      <div data-testid="host">
        <AddFromImportsButton modelVersionId={42} />
      </div>
    );

    await expect.element(page.getByTestId('host')).toBeInTheDocument();
    expect(page.getByTestId('host').element().childElementCount).toBe(0);
  });
});
