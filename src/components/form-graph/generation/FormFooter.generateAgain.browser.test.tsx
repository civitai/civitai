import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as WhatIfProviderModule from '~/components/form-graph/generation/WhatIfProvider';
import type * as BuzzModule from '~/components/Buzz/useBuzz';
import type * as ToursModule from '~/components/Tours/ToursProvider';
import type * as GenerationProviderModule from '~/components/ImageGeneration/GenerationProvider';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as ResourceDataProviderModule from '~/components/generation_v2/inputs/ResourceDataProvider';

/**
 * After a submit the Generate button confirms it, then reads "Generate again" while the form is
 * what was submitted. The store is the real generation graph; what the button reads from elsewhere
 * (estimate, balance, flags) is a fixture.
 */

vi.mock('~/components/form-graph/generation/WhatIfProvider', async (orig) => ({
  ...(await orig<typeof WhatIfProviderModule>()),
  useWhatIfContext: () => ({
    isLoading: false,
    isError: false,
    isSuccess: true,
    error: null,
    refetch: () => undefined,
    canEstimateCost: true,
    gateBlocked: false,
    data: { cost: { base: 37, total: 37 }, ready: true },
  }),
}));

vi.mock('~/components/Buzz/useBuzz', async (orig) => ({
  ...(await orig<typeof BuzzModule>()),
  useQueryBuzz: () => ({
    data: {
      accounts: (['green', 'blue', 'yellow'] as const).map((type) => ({
        type,
        balance: 1_000_000,
      })),
    },
    isLoading: false,
  }),
}));

vi.mock('~/components/Tours/ToursProvider', async (orig) => ({
  ...(await orig<typeof ToursModule>()),
  useTourContext: () => ({
    running: false,
    activeTour: undefined,
    helpers: undefined,
    pauseTour: () => undefined,
    setBlockedTarget: () => undefined,
  }),
}));

vi.mock('~/components/ImageGeneration/GenerationProvider', async (orig) => ({
  ...(await orig<typeof GenerationProviderModule>()),
  useGenerationContext: <T,>(selector: (s: { canGenerate: boolean }) => T) =>
    selector({ canGenerate: true }),
}));

vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ creatorComp: false, isGreen: true }),
}));

vi.mock('~/components/generation_v2/inputs/ResourceDataProvider', async (orig) => ({
  ...(await orig<typeof ResourceDataProviderModule>()),
  useResourceDataContext: () => ({
    registerResourceId: () => undefined,
    unregisterResourceId: () => undefined,
    getResourceData: () => undefined,
    resources: [],
    isLoading: false,
    isResourceLoading: () => false,
  }),
}));

// eslint-disable-next-line import/first
import { SUBMITTED_FLASH_MS, SubmitButton } from '~/components/form-graph/generation/FormFooter';
// eslint-disable-next-line import/first
import { formStateKey } from '~/components/form-graph/generation/store';
// eslint-disable-next-line import/first
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
// eslint-disable-next-line import/first
import type { GenerationCtx } from '~/shared/generation/context';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

function imageStore() {
  const store = generationHub.createStore({ ext: EXT });
  store.set({ workflow: 'txt2img', ecosystem: 'SDXL', prompt: 'a cat' });
  return store;
}

describe('SubmitButton after a submit', () => {
  test('before any submit it reads Generate', async () => {
    renderWithProviders(<SubmitButton store={imageStore()} />);
    await expect.element(page.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
  });

  test('it confirms, then reads Generate again until the form changes', async () => {
    const store = imageStore();
    renderWithProviders(
      <SubmitButton store={store} lastSubmitted={{ key: formStateKey(store), at: Date.now() }} />
    );

    await expect.element(page.getByRole('button', { name: 'Submitted' })).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Generate again' }), {
        timeout: SUBMITTED_FLASH_MS + 2000,
      })
      .toBeVisible();

    store.set({ prompt: 'a dog' });
    await expect.element(page.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
  });
});
