import { afterEach, describe, expect, test, vi } from 'vitest';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ isGreen: false }),
}));
vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({ trackAction: vi.fn(() => Promise.resolve()) }),
}));

import { GenerateButton } from '~/components/RunStrategy/GenerateButton';
import { renderWithProviders } from '../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';

afterEach(() => cleanup());

const chipText = () =>
  document.body.querySelector('.mantine-Badge-root')?.textContent?.trim() ?? null;

describe('Generate button price chip', () => {
  test.each([
    [3500, '3.5k'],
    [12500, '12.5k'],
    [4000, '4k'],
    [950, '950'],
  ])('a %i Buzz price reads %s, never rounded to a whole thousand', async (price, text) => {
    renderWithProviders(<GenerateButton generationPrice={price} />);
    await vi.waitFor(() => expect(chipText()).toBe(text));
  });
});
