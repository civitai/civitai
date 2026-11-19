import { MantineProvider } from '@mantine/core';
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { theme } from '~/providers/ThemeProvider';

vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useBrowsingSettings: (sel: (s: unknown) => unknown) =>
    sel({
      showEventCosmetics: true,
      showNsfw: true,
      blurNsfw: true,
      disableHidden: false,
      browsingLevel: 1,
      setState: vi.fn(),
    }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ canViewNsfw: true, newOrderGame: false }),
}));
vi.mock('~/hooks/useIsRegionRestricted', () => ({
  useIsRegionRestricted: () => ({ isRestricted: false }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelsGrouped', () => ({
  BrowsingLevelsGrouped: () => <div>levels</div>,
}));
vi.mock('~/components/Account/HiddenTagsSection', () => ({
  HiddenTagsSection: () => <div>hidden tags list</div>,
}));

const { BrowsingModeIcon } = await import('~/components/BrowsingMode/BrowsingMode');
const { DialogProvider } = await import('~/components/Dialog/DialogProvider');

describe('Browsing Level menu: "my filters"', () => {
  test('opens the hidden tags list', async () => {
    render(
      <MantineProvider theme={theme}>
        <BrowsingModeIcon />
        <DialogProvider />
      </MantineProvider>
    );
    await page.getByLabelText('Browsing mode').click();
    await page.getByText('my filters').click();
    await expect.element(page.getByText('hidden tags list')).toBeVisible();
  });
});
