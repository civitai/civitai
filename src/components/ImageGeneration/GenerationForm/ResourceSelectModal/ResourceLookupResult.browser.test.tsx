import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcMod from '~/utils/trpc';
import { renderWithProviders } from '../../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

/**
 * A pasted link must be held to the same browsing-level and hidden-content rules as a search hit.
 * The server applies no level filter (the grid filters client-side), so this component's pass
 * through `useApplyHiddenPreferences` is the only thing keeping a too-mature model off screen.
 */

const hit = {
  id: 101,
  name: 'Ink Wash Style',
  type: 'LORA',
  versions: [{ id: 1001, name: 'v1', baseModel: 'Pony', canGenerate: true }],
};
const prefs = vi.hoisted(() => ({ hide: false }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'model.getResourceSelect': {
      useQuery: () => ({
        data: { items: [hit], coverageNext: false, member: true },
        isLoading: false,
        isError: false,
      }),
    },
  }),
}));

vi.mock('~/components/HiddenPreferences/useApplyHiddenPreferences', () => ({
  useApplyHiddenPreferences: ({ data }: { data?: unknown[] }) =>
    prefs.hide
      ? { items: [], loadingPreferences: false, hiddenCount: data?.length ?? 0 }
      : { items: data ?? [], loadingPreferences: false, hiddenCount: 0 },
}));

vi.mock('~/components/ImageGeneration/GenerationForm/ResourceSelectProvider', () => ({
  useResourceSelectContext: () => ({
    selectSource: 'addResource',
    canGenerate: undefined,
    resources: [{ type: 'LORA', baseModels: ['Pony'] }],
    filters: { types: [], baseModels: [], loadedOnly: false, turboOnly: false },
    excludedIds: [],
    excludeTurbo: false,
  }),
}));

vi.mock('./ResourceSelectCard', () => ({
  ResourceSelectCard: ({ data }: { data: { name: string } }) => <div>card: {data.name}</div>,
}));

const { ResourceLookupResult } = await import('./ResourceLookupResult');

describe('ResourceLookupResult', () => {
  test('shows the card for a model the viewer may see', async () => {
    prefs.hide = false;
    renderWithProviders(<ResourceLookupResult lookup={{ modelId: 101 }} />);
    await expect.element(page.getByText('card: Ink Wash Style')).toBeInTheDocument();
  });

  test("hides a model the viewer's browsing level or hidden settings exclude", async () => {
    prefs.hide = true;
    renderWithProviders(<ResourceLookupResult lookup={{ modelId: 101 }} />);
    // Wait for either outcome, so a leak fails on the assertion below rather than on a timeout.
    await expect.poll(() => document.body.textContent).toMatch(/hidden due to your settings|card:/);
    expect(page.getByText(/Ink Wash Style/).elements()).toHaveLength(0);
    expect(document.body.textContent).toContain('This model has been hidden due to your settings.');
  });
});
