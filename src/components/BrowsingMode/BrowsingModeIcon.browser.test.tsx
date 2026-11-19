import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';

const { restricted } = vi.hoisted(() => ({ restricted: { value: false } }));
vi.mock('~/hooks/useIsRegionRestricted', () => ({
  useIsRegionRestricted: () => ({ isRestricted: restricted.value, isPendingRestriction: false }),
}));

import { BrowsingModeIcon } from '~/components/BrowsingMode/BrowsingMode';

const button = () => page.getByLabelText('Browsing mode', { exact: true });

describe('BrowsingModeIcon', () => {
  afterEach(() => {
    restricted.value = false;
  });

  test('a region-restricted viewer still gets the red dot', async () => {
    restricted.value = true;
    renderWithProviders(<BrowsingModeIcon />);
    await expect.element(button()).toBeVisible();
    const indicator = button().element().closest('.mantine-Indicator-root');
    expect(indicator?.querySelector('.mantine-Indicator-indicator')).not.toBeNull();
  });
});
