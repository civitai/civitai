import { Menu } from '@mantine/core';
import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { TrainingAuditMenuItem } from '~/components/Moderation/TrainingAuditMenuItem';
import { ModelUploadType } from '~/shared/utils/prisma/enums';

const renderMenu = (props: Parameters<typeof TrainingAuditMenuItem>[0]) =>
  renderWithProviders(
    <Menu opened withinPortal={false}>
      <Menu.Target>
        <button>Options</button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item>Other action</Menu.Item>
        <TrainingAuditMenuItem {...props} />
      </Menu.Dropdown>
    </Menu>
  );

describe('TrainingAuditMenuItem', () => {
  test('links a moderator on an on-site-trained model to its training audit', async () => {
    renderMenu({ modelId: 4821, uploadType: ModelUploadType.Trained, isModerator: true });

    const link = page.getByRole('menuitem', { name: 'Training audit' });
    await expect.element(link).toBeVisible();
    await expect
      .element(link)
      .toHaveAttribute('href', expect.stringMatching(/\/audit\/training-models\?modelId=4821$/));
  });

  test('is absent for a model that was not trained on site', async () => {
    renderMenu({ modelId: 4821, uploadType: ModelUploadType.Created, isModerator: true });

    await expect.element(page.getByRole('menuitem', { name: 'Other action' })).toBeVisible();
    await expect.element(page.getByText('Training audit')).not.toBeInTheDocument();
  });

  test('is absent for anyone who is not a moderator', async () => {
    renderMenu({ modelId: 4821, uploadType: ModelUploadType.Trained, isModerator: false });

    await expect.element(page.getByRole('menuitem', { name: 'Other action' })).toBeVisible();
    await expect.element(page.getByText('Training audit')).not.toBeInTheDocument();
  });
});
