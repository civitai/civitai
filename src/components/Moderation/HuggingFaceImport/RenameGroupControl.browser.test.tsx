import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as NotificationsModule from '~/utils/notifications';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../test/component-setup';

const { mockMutate } = vi.hoisted(() => ({ mockMutate: vi.fn() }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    useUtils: () => ({
      huggingFaceImport: {
        getAll: { invalidate: vi.fn() },
        getCounts: { invalidate: vi.fn() },
      },
    }),
    huggingFaceImport: {
      renameGroup: { useMutation: () => ({ mutate: mockMutate, isPending: false }) },
    },
  },
}));
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsModule>()),
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

import { RenameGroupControl } from '~/components/Moderation/HuggingFaceImport/RenameGroupControl';

async function openRename() {
  renderWithProviders(
    <RenameGroupControl repo="owner/name" revision="abc123" groupName="flux-krea" />
  );
  await page.getByRole('button', { name: 'Rename group' }).click();
  const input = page.getByLabelText('Group name');
  await expect.element(input).toHaveValue('flux-krea');
  return input;
}

beforeEach(() => mockMutate.mockReset());

describe('RenameGroupControl', () => {
  test('renames the group it was opened on, from its current name', async () => {
    const input = await openRename();
    await input.fill('  FLUX Krea  ');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();

    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenCalledWith({
      repo: 'owner/name',
      revision: 'abc123',
      from: 'flux-krea',
      groupName: 'FLUX Krea',
    });
  });

  test('submits on Enter', async () => {
    const input = await openRename();
    await input.fill('FLUX Krea');
    await userEvent.keyboard('{Enter}');

    expect(mockMutate).toHaveBeenCalledTimes(1);
  });

  test('will not submit an empty or unchanged name', async () => {
    const input = await openRename();
    const save = page.getByRole('button', { name: 'Rename', exact: true });

    await expect.element(save).toBeDisabled();
    await input.fill('   ');
    await expect.element(save).toBeDisabled();
    await userEvent.keyboard('{Enter}');

    expect(mockMutate).not.toHaveBeenCalled();
  });
});
