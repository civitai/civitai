import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import type * as DialogStoreModule from '~/components/Dialog/dialogStore';
import type * as MobileGenerator from '~/hooks/useMobileGenerator';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

// The mobile generator comes from the flag and media queries, which the test browser can't set.
vi.mock('~/hooks/useMobileGenerator', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileGenerator>()),
  useMobileGenerator: () => true,
  useGeneratorLayout: () => 'mobile',
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'generationPreset.getOwn': { useQuery: () => ({ isSuccess: true, data: [{ id: 1 }] }) },
  }),
}));
const trigger = vi.hoisted(() => vi.fn());
vi.mock('~/components/Dialog/dialogStore', async (importOriginal) => ({
  ...(await importOriginal<typeof DialogStoreModule>()),
  dialogStore: { trigger },
}));

import { PresetHeaderButton } from '~/components/generation_v2/preset/PresetHeaderButton';

describe('PresetHeaderButton in the mobile generator', () => {
  test('opens its actions as a sheet, and an action closes the sheet and opens its dialog', async () => {
    renderWithProviders(<PresetHeaderButton />);
    await page.getByRole('button', { name: 'Presets' }).click();

    const sheet = page.getByRole('dialog', { name: 'Presets' });
    await expect.element(sheet.getByRole('button', { name: 'Manage presets' })).toBeInTheDocument();
    // Nothing to save until the form has registered its snapshot.
    await expect.element(sheet.getByRole('button', { name: 'Save current values' })).toBeDisabled();

    await sheet.getByRole('button', { name: 'View presets' }).click();
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ id: 'preset-picker' }));
    await expect.element(sheet).not.toBeInTheDocument();
  });
});
