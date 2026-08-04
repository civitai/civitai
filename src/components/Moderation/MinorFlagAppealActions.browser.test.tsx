import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import {
  MinorFlagAppealActions,
  type MinorFlagAppealActionRow,
} from '~/components/Moderation/MinorFlagAppealActions';

const row = (overrides: Partial<MinorFlagAppealActionRow> = {}): MinorFlagAppealActionRow => ({
  modelId: 2186217,
  modelName: 'Some Checkpoint',
  minor: true,
  prevNsfw: null,
  prevGalleryLevel: null,
  ...overrides,
});

describe('MinorFlagAppealActions', () => {
  // Upholding a flag that is no longer in force writes nothing but still tells the
  // uploader their request was denied — a false statement about a child-safety
  // restriction. Reverting from the Auto-flagged tab leaves exactly this state.
  test('cannot uphold a flag that has already been reverted', async () => {
    renderWithProviders(
      <MinorFlagAppealActions row={row({ minor: false })} onResolve={vi.fn()} />
    );

    await expect.element(page.getByRole('button', { name: 'Keep flagged' })).toBeDisabled();
  });

  // Approving is the only way left to close the request, so it must stay live.
  test('can still unflag a reverted row so the request can be closed', async () => {
    renderWithProviders(
      <MinorFlagAppealActions row={row({ minor: false })} onResolve={vi.fn()} />
    );

    await expect.element(page.getByRole('button', { name: 'Unflag' })).toBeEnabled();
  });

  test('both actions are live while the flag stands', async () => {
    renderWithProviders(<MinorFlagAppealActions row={row({ minor: true })} onResolve={vi.fn()} />);

    await expect.element(page.getByRole('button', { name: 'Keep flagged' })).toBeEnabled();
    await expect.element(page.getByRole('button', { name: 'Unflag' })).toBeEnabled();
  });
});
