import { MultiSelect } from '@mantine/core';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as InstantSearch from 'react-instantsearch';

/**
 * The SFW-only badge on each surface that renders it through `SfwOnlyBadge`: the generator picker
 * (real `BaseModelListContent` over the real ecosystem display items), the base model filter (the
 * Models and Images dropdowns share `baseModelSelectData` + `renderBaseModelOption`) and the search
 * refinement list (real `SearchableMultiSelectRefinementList`, instantsearch stubbed). The model
 * page row has its own full-mount file; the resource card shield lives in
 * ResourceItemContent.browser.test.tsx.
 */

const mocks = vi.hoisted(() => ({
  domain: { green: false, blue: true, red: false },
  refinementItems: [] as Array<{ label: string; value: string; isRefined: boolean; count: number }>,
}));

// .red is configured as both a blue and a red host, so its client context reads blue.
vi.mock('~/providers/AppProvider', () => ({
  useAppContext: () => ({ domain: mocks.domain }),
}));

vi.mock('react-instantsearch', async (importOriginal) => ({
  ...(await importOriginal<typeof InstantSearch>()),
  useRefinementList: () => ({
    items: mocks.refinementItems,
    refine: vi.fn(),
    searchForItems: vi.fn(),
  }),
}));

const { SfwOnlyBadge, renderBaseModelOption } = await import('./SfwOnlyBadge');
const { BaseModelListContent } = await import('~/components/generation_v2/inputs/BaseModelInput');
const { SearchableMultiSelectRefinementList } = await import(
  '~/components/Search/CustomSearchComponents'
);
const { baseModelSelectData, ecosystemByKey, getEcosystemDisplayItems } = await import(
  '~/shared/constants/basemodel.constants'
);
const { getWorkflowsForEcosystem } = await import('~/shared/generation/config/workflows');
const { nsfwRestrictedBaseModels } = await import('~/server/common/constants');

const RED = { green: false, blue: true, red: false };
const GREEN = { green: true, blue: false, red: false };
const TOOLTIP = "Mature content can't be posted with this base model.";

const badges = () => document.querySelectorAll('[data-testid="sfw-only-badge"]');

beforeEach(() => {
  mocks.domain = RED;
  mocks.refinementItems = [];
});

describe('SfwOnlyBadge', () => {
  test.each(['Ideogram 4.5', 'SD 3.5 Large', 'SDXL Turbo'])(
    '%s shows the badge on red',
    async (bm) => {
      renderWithProviders(<SfwOnlyBadge baseModel={bm} />);
      await expect.element(page.getByText('SFW only')).toBeInTheDocument();
    }
  );

  test('the tooltip says posting is what is blocked', async () => {
    renderWithProviders(<SfwOnlyBadge baseModel="Ideogram 4.5" />);
    await page.getByText('SFW only').hover();
    await expect.element(page.getByText(TOOLTIP)).toBeInTheDocument();
  });

  test.each(['Illustrious', 'SDXL 1.0', 'Flux.2 D'])('%s shows nothing on red', async (bm) => {
    renderWithProviders(
      <>
        <span>anchor</span>
        <SfwOnlyBadge baseModel={bm} />
      </>
    );
    await expect.element(page.getByText('anchor')).toBeInTheDocument();
    expect(badges()).toHaveLength(0);
  });

  test('shows nothing on .com (green), even for a restricted base', async () => {
    mocks.domain = GREEN;
    renderWithProviders(
      <>
        <span>anchor</span>
        <SfwOnlyBadge baseModel="Ideogram 4.5" />
      </>
    );
    await expect.element(page.getByText('anchor')).toBeInTheDocument();
    expect(badges()).toHaveLength(0);
  });
});

describe('generator base model picker', () => {
  // What the picker offers: ecosystems with a dedicated generation workflow (as in BaseModelInput).
  const hasWorkflow = (id: number) =>
    getWorkflowsForEcosystem(id).some((w) => w.ecosystemIds.includes(id));
  const items = getEcosystemDisplayItems().filter((item) =>
    item.type === 'group'
      ? (item.ecosystemIds ?? []).some(hasWorkflow)
      : hasWorkflow(ecosystemByKey.get(item.key)?.id ?? -1)
  );
  const renderPicker = () =>
    renderWithProviders(
      <BaseModelListContent
        recentItems={[]}
        groupedByFamily={[{ familyId: null, familyName: null, items }]}
        allGroupedByFamily={[{ familyId: null, familyName: null, items }]}
        onSelect={vi.fn()}
        activeTab="all"
        onTabChange={vi.fn()}
        showRecentTab={false}
      />
    );
  // The picker row whose leading name is exactly `name`.
  const row = (name: string) =>
    Array.from(document.querySelectorAll('button')).find(
      (b) => b.querySelector('p')?.textContent === name
    );

  // Today Ideogram is the only offered ecosystem whose every base is restricted; SDXL holds SDXL
  // Turbo but is not. If a new one appears, add it here after checking the badge belongs.
  test('marks Ideogram and nothing else on red', async () => {
    renderPicker();
    await expect.element(page.getByText('Ideogram', { exact: true })).toBeInTheDocument();
    expect(row('Ideogram')?.querySelector('[data-testid="sfw-only-badge"]')).toBeTruthy();
    for (const name of ['Stable Diffusion XL', 'Illustrious']) {
      const r = row(name);
      expect(r, `${name} row rendered`).toBeTruthy();
      expect(r?.querySelector('[data-testid="sfw-only-badge"]'), name).toBeNull();
    }
    expect(badges()).toHaveLength(1);
  });

  test('marks nothing on .com', async () => {
    mocks.domain = GREEN;
    renderPicker();
    await expect.element(page.getByText('Ideogram', { exact: true })).toBeInTheDocument();
    expect(badges()).toHaveLength(0);
  });
});

describe('base model filter (Models and Images)', () => {
  const renderFilter = () =>
    renderWithProviders(
      <MultiSelect
        data={baseModelSelectData}
        placeholder="All Base Models"
        renderOption={renderBaseModelOption}
        comboboxProps={{ withinPortal: false }}
        maxDropdownHeight={10000}
      />
    );
  const optionHasBadge = (name: string) => {
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
      o.textContent?.startsWith(name)
    );
    expect(option, `option ${name}`).toBeTruthy();
    return !!option?.querySelector('[data-testid="sfw-only-badge"]');
  };

  test('marks exactly the restricted bases on red', async () => {
    renderFilter();
    await page.getByPlaceholder('All Base Models').click();
    await expect.element(page.getByRole('option', { name: /^SDXL 1\.0/ })).toBeInTheDocument();

    // The filter lists only bases that are not hidden; of the restricted ones that is Ideogram 4.0.
    expect(optionHasBadge('Ideogram 4.0')).toBe(true);
    for (const bm of ['Illustrious', 'SDXL 1.0', 'Flux.2 D'])
      expect(optionHasBadge(bm), bm).toBe(false);
    // Hidden bases are not offered, so the count is the restricted ones the filter lists.
    const offered = new Set(baseModelSelectData.flatMap((g) => g.items.map((i) => i.value)));
    expect(badges()).toHaveLength(nsfwRestrictedBaseModels.filter((b) => offered.has(b)).length);
  });

  test('marks nothing on .com', async () => {
    mocks.domain = GREEN;
    renderFilter();
    await page.getByPlaceholder('All Base Models').click();
    await expect.element(page.getByRole('option', { name: /^SDXL 1\.0/ })).toBeInTheDocument();
    expect(badges()).toHaveLength(0);
  });
});

describe('search refinement list', () => {
  const renderRefinement = () => {
    mocks.refinementItems = ['SD 3.5 Large Turbo', 'SDXL 1.0', 'Ideogram 4.5'].map((value) => ({
      label: value,
      value,
      isRefined: false,
      count: 1,
    }));
    renderWithProviders(
      <SearchableMultiSelectRefinementList
        title="Filter by Base Model"
        attribute="baseModel"
        renderOption={renderBaseModelOption}
        searchable
      />
    );
  };

  test('marks restricted bases on red', async () => {
    renderRefinement();
    await page.getByPlaceholder('Search Filter by Base Model').click();
    await expect.element(page.getByRole('option', { name: /^SDXL 1\.0/ })).toBeInTheDocument();
    expect(badges()).toHaveLength(2);
  });

  test('marks nothing on .com', async () => {
    mocks.domain = GREEN;
    renderRefinement();
    await page.getByPlaceholder('Search Filter by Base Model').click();
    await expect.element(page.getByRole('option', { name: /^SDXL 1\.0/ })).toBeInTheDocument();
    expect(badges()).toHaveLength(0);
  });
});
