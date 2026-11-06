import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import type * as MantineHooks from '@mantine/hooks';
import { renderWithProviders } from '../../../../test/component-setup';

// Mock notes:
// - The store mock must APPLY the selector (`mockImplementation((sel) => sel(state))`). A fixed
//   `mockReturnValue` hands both selector calls the same object and breaks the grouped-value tests.
// - Which surface opens depends on media queries over the real viewport, so `@mantine/hooks` is
//   mocked via importActual with only useMediaQuery overridden. `setMobile(true)` makes every query
//   match; with no flag provider the mobile generator is off, so that is the legacy generator on a
//   narrow screen. Which surface opens where is PopoverOrSheet's own test.

vi.mock('~/store/ecosystem-group-preferences.store', () => ({
  useEcosystemGroupPreferencesStore: vi.fn(),
}));

vi.mock('@mantine/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof MantineHooks>()),
  useMediaQuery: vi.fn(() => false), // default: desktop; overridden per test
}));

import { BaseModelInput } from '~/components/generation_v2/inputs/BaseModelInput';
import { trackRecentEcosystem, useRecentEcosystemsStore } from '~/store/recent-ecosystems.store';
import { getEcosystemDisplayItems } from '~/shared/constants/basemodel.constants';
import { useEcosystemGroupPreferencesStore } from '~/store/ecosystem-group-preferences.store';
import { useMediaQuery } from '@mantine/hooks';

const storeMock = vi.mocked(useEcosystemGroupPreferencesStore);
const useMediaQueryMock = vi.mocked(useMediaQuery);

// Controlled store STATE. The component selects getLastUsedEcosystem /
// setLastUsedEcosystem off this object via its selector.
const makeState = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    lastUsedEcosystems: {},
    getLastUsedEcosystem: vi.fn(() => undefined),
    setLastUsedEcosystem: vi.fn(),
    ...over,
  } as any);

let state: ReturnType<typeof makeState>;

const setMobile = (isMobile: boolean) => useMediaQueryMock.mockReturnValue(isMobile);

describe('BaseModelInput (public component — selector-store + media-query)', () => {
  beforeEach(() => {
    storeMock.mockReset();
    useMediaQueryMock.mockReset();
    state = makeState();
    // Selector-FORM mock: apply the component's selector against STATE.
    storeMock.mockImplementation((sel: any) => sel(state));
    setMobile(false); // desktop by default
  });

  test('value=undefined renders the trigger with the "Select" placeholder', async () => {
    renderWithProviders(<BaseModelInput value={undefined} onChange={vi.fn()} />);

    // readableName = 'Select' when there is no value. Trigger is an
    // UnstyledButton whose accessible name is its text content + the "Eco" prefix.
    const btn = page.getByRole('button', { name: /Select/ });
    await expect.element(btn).toBeInTheDocument();
    await expect.element(page.getByText('Select', { exact: true })).toBeInTheDocument();
  });

  test('a known ecosystem value renders its displayName (not the raw key)', async () => {
    // 'SD1' is a standalone ecosystem (no group) -> readableName = eco.displayName.
    renderWithProviders(<BaseModelInput value="SD1" onChange={vi.fn()} />);

    await expect
      .element(page.getByText('Stable Diffusion 1.x', { exact: true }))
      .toBeInTheDocument();
    // The raw key must NOT be what's shown.
    await expect.element(page.getByText('SD1', { exact: true })).not.toBeInTheDocument();
  });

  test('a grouped ecosystem value renders the GROUP displayName (group beats eco)', async () => {
    // 'WanVideo-25-T2V' is part of the WanVideo group. readableName resolves to
    // the GROUP displayName ('Wan Video'), NOT the ecosystem's own displayName
    // ('Wan Video 2.5 T2V') — teeth: distinguishes the group path from the eco path.
    renderWithProviders(<BaseModelInput value="WanVideo-25-T2V" onChange={vi.fn()} />);

    await expect.element(page.getByText('Wan Video', { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText('Wan Video 2.5 T2V', { exact: true }))
      .not.toBeInTheDocument();
  });

  test('an unknown value falls back to rendering the raw value string', async () => {
    // ecosystemByKey.get('not-a-real-eco') is undefined -> readableName = value.
    renderWithProviders(<BaseModelInput value="not-a-real-eco" onChange={vi.fn()} />);

    await expect.element(page.getByText('not-a-real-eco', { exact: true })).toBeInTheDocument();
  });

  test('disabled disables the trigger button', async () => {
    renderWithProviders(<BaseModelInput value="SD1" onChange={vi.fn()} disabled />);

    const btn = page.getByRole('button', { name: /Stable Diffusion 1\.x/ });
    await expect.element(btn).toBeDisabled();
  });

  test('narrow screen: the trigger opens the full-screen picker, ready to search', async () => {
    setMobile(true); // the legacy generator under 768px
    renderWithProviders(<BaseModelInput value="SD1" onChange={vi.fn()} />);

    await page.getByRole('button', { name: /Stable Diffusion 1\.x/ }).click();

    await expect
      .element(page.getByRole('dialog', { name: 'Select Base Model' }))
      .toBeInTheDocument();
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute('placeholder')).toBe('Search ecosystems...')
    );
  });

  test('selecting a grouped value tracks it via setLastUsedEcosystem(group.id, value)', async () => {
    // The value-change effect: for a value whose ecosystem belongs to a group,
    // the component calls setLastUsedEcosystem(group.id, value). 'WanVideo-25-T2V'
    // is in the 'WanVideo' group -> setLastUsedEcosystem('WanVideo','WanVideo-25-T2V').
    renderWithProviders(<BaseModelInput value="WanVideo-25-T2V" onChange={vi.fn()} />);

    await vi.waitFor(() =>
      expect(state.setLastUsedEcosystem).toHaveBeenCalledWith('WanVideo', 'WanVideo-25-T2V')
    );
  });

  test("an ecosystem tracked elsewhere (a submission) shows on the picker's Recent tab", async () => {
    useRecentEcosystemsStore.setState({ recent: [] });
    const tracked = getEcosystemDisplayItems().find(
      (i) => i.type === 'ecosystem' && i.key !== 'SD1'
    )!;
    renderWithProviders(<BaseModelInput value="SD1" onChange={vi.fn()} />);

    trackRecentEcosystem(tracked.key);
    await page.getByRole('button', { name: /Stable Diffusion 1.x/ }).click();
    await page.getByRole('button', { name: 'Recent', exact: true }).click();

    await expect.element(page.getByText(tracked.name, { exact: true }).first()).toBeVisible();
  });
});
