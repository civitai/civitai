import Router from 'next/router';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { FiltersProvider } from '~/providers/FiltersProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const features = vi.hoisted(() => ({ music: false as boolean | undefined }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useOptionalFeatureFlags: () => ({ music: features.music }),
}));
vi.mock('~/components/HatTurf/useHatTurfFeedPlayer', () => ({ useHatTurfFeedPlayer: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));
vi.mock('~/hooks/useIsClient', () => ({ default: () => true }));
vi.mock('~/hooks/useDomainColor', () => ({ useDomainColor: () => 'blue' }));
vi.mock('~/components/Tool/ToolMultiSelect', () => ({ ToolMultiSelect: () => null }));
vi.mock('~/components/Technique/TechniqueMultiSelect', () => ({
  TechniqueMultiSelect: () => null,
}));
vi.mock('~/components/SfwOnlyBadge/BaseModelFilterSelect', () => ({
  BaseModelFilterSelect: () => null,
}));
vi.mock('~/hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useIsMobile: () => false,
  isMobileDevice: () => false,
}));

const onChange = vi.fn();
const render = () =>
  renderWithProviders(
    <FiltersProvider>
      <MediaFiltersDropdown filterType="images" query={{ types: ['image'] }} onChange={onChange} />
    </FiltersProvider>
  );
const openFilters = () => page.getByRole('button', { name: 'Filters', exact: true }).click();
const chip = (name: string) => page.getByRole('checkbox', { name, exact: true });

beforeEach(() => {
  localStorage.clear();
  onChange.mockClear();
});

afterEach(() => {
  Router.query = {};
});

describe('the Audio media type chip', () => {
  test('with the music flag on, Audio adds audio to the types', async () => {
    features.music = true;
    render();
    await openFilters();
    await chip('Audio').click();
    await page.getByRole('button', { name: 'Apply filters' }).click();

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ types: expect.arrayContaining(['image', 'audio']) })
    );
  });

  test('with the music flag off, only Image and Video are offered', async () => {
    features.music = undefined;
    render();
    await openFilters();
    await expect.element(chip('Image')).toBeInTheDocument();
    await expect.element(chip('Video')).toBeInTheDocument();
    expect(chip('Audio').query()).toBeNull();
  });
});
