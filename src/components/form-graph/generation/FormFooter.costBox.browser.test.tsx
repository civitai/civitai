import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as WhatIfProviderModule from '~/components/form-graph/generation/WhatIfProvider';
import type * as BuzzModule from '~/components/Buzz/useBuzz';
import type * as ToursModule from '~/components/Tours/ToursProvider';
import type * as GenerationProviderModule from '~/components/ImageGeneration/GenerationProvider';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type * as ResourceDataProviderModule from '~/components/generation_v2/inputs/ResourceDataProvider';
import type { GenerationStore } from '~/components/form-graph/generation/store';

/**
 * The cost box beside Generate must spin only while something is actually in flight (an estimate,
 * or a source image upload). When the form is invalid (or the selection is gate-blocked) with
 * nothing pending, the whatIf query is disabled, the cost stays 0, and the box used to spin until
 * the form changed — read by users as "the upload spins forever". Generate must stay disabled in
 * those states either way.
 *
 * The whatIf context is replaced with a fixture so each test sets exactly the state the footer
 * reads; everything below it (the cost box, Generate) renders for real.
 */

type WhatIfFixture = {
  isLoading: boolean;
  isError: boolean;
  canEstimateCost: boolean;
  gateBlocked: boolean;
  total: number;
};

const state = vi.hoisted(() => ({
  whatIf: {
    isLoading: false,
    isError: false,
    canEstimateCost: true,
    gateBlocked: false,
    total: 0,
  } as {
    isLoading: boolean;
    isError: boolean;
    canEstimateCost: boolean;
    gateBlocked: boolean;
    total: number;
  },
}));

vi.mock('~/components/form-graph/generation/WhatIfProvider', async (orig) => ({
  ...(await orig<typeof WhatIfProviderModule>()),
  useWhatIfContext: () => ({
    isLoading: state.whatIf.isLoading,
    isError: state.whatIf.isError,
    isSuccess: !state.whatIf.isLoading && !state.whatIf.isError,
    error: null,
    refetch: () => undefined,
    canEstimateCost: state.whatIf.canEstimateCost,
    gateBlocked: state.whatIf.gateBlocked,
    data: { cost: { base: state.whatIf.total, total: state.whatIf.total }, ready: true },
  }),
}));

// A balance well above any fixture cost, so "insufficient Buzz" never decides Generate's state.
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

// creatorComp off: no tips are added, so the displayed cost is exactly the fixture total.
vi.mock('~/providers/FeatureFlagsProvider', async (orig) => ({
  ...(await orig<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ creatorComp: false, isGreen: true }),
}));

// The cost box reads creator-tip eligibility from the resource data context; with no resources
// selected no tip applies, so the displayed cost stays exactly the fixture total.
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
import {
  ConnectedBuzzTypeSelector,
  SubmitButton,
} from '~/components/form-graph/generation/FormFooter';

const store = { getSnapshot: () => ({ state: {} }) } as unknown as GenerationStore;

const footerUi = () => (
  <div>
    <SubmitButton store={store} />
    <ConnectedBuzzTypeSelector store={store} />
  </div>
);

function renderFooter(whatIf: WhatIfFixture) {
  state.whatIf = whatIf;
  return renderWithProviders(footerUi());
}

function costButton() {
  const el = document.querySelector<HTMLButtonElement>('button[data-tour="gen:buzz"]');
  if (!el) throw new Error('cost button not found');
  return el;
}

const costSpinning = () => costButton().querySelector('.mantine-Button-loader') !== null;

function generateButton() {
  const label = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Generate'
  );
  if (!label) throw new Error('Generate button not found');
  return label;
}

const base: WhatIfFixture = {
  isLoading: false,
  isError: false,
  canEstimateCost: true,
  gateBlocked: false,
  total: 0,
};

describe('FormFooter cost box', () => {
  beforeEach(() => {
    state.whatIf = { ...base };
  });

  test('invalid form: no spinner, a dash instead of a cost, Generate disabled', async () => {
    renderFooter({ ...base, canEstimateCost: false });
    await vi.waitFor(() => costButton());
    expect(costSpinning()).toBe(false);
    expect(costButton().textContent).toContain('–');
    expect(costButton().textContent).not.toContain('0');
    expect(generateButton().disabled).toBe(true);
  });

  test('invalid form while the first image is uploading: spinner shown, Generate disabled', async () => {
    // The provider folds "images pending" into isLoading. The form is invalid only until the upload
    // lands, and an estimate follows it, so this is a real wait.
    renderFooter({ ...base, canEstimateCost: false, isLoading: true });
    await vi.waitFor(() => costButton());
    expect(costSpinning()).toBe(true);
    expect(generateButton().disabled).toBe(true);
  });

  test('the upload then fails, leaving the form invalid: spinner gives way to a dash', async () => {
    const view = await renderFooter({ ...base, canEstimateCost: false, isLoading: true });
    await vi.waitFor(() => costButton());
    expect(costSpinning()).toBe(true);

    state.whatIf = { ...base, canEstimateCost: false, isLoading: false };
    await view.rerender(footerUi());
    await vi.waitFor(() => expect(costSpinning()).toBe(false));
    expect(costButton().textContent).toContain('–');
    expect(generateButton().disabled).toBe(true);
  });

  test('gate-blocked selection while an image is uploading: spinner shown, Generate disabled', async () => {
    // Something is in flight, so the box spins; once the upload settles the gate leaves a dash.
    renderFooter({ ...base, gateBlocked: true, isLoading: true });
    await vi.waitFor(() => costButton());
    expect(costSpinning()).toBe(true);
    expect(generateButton().disabled).toBe(true);
  });

  test('gate-blocked selection with no cost yet: no spinner', async () => {
    renderFooter({ ...base, gateBlocked: true });
    await vi.waitFor(() => costButton());
    expect(costSpinning()).toBe(false);
  });

  test('gate-blocked selection: no spinner, Generate disabled', async () => {
    // A valid payload can still hold a cached cost from before the gate applied, so the dash must
    // not depend on the cost being 0.
    renderFooter({ ...base, gateBlocked: true, total: 37 });
    await vi.waitFor(() => costButton());
    expect(costSpinning()).toBe(false);
    expect(costButton().textContent).toContain('–');
    expect(costButton().textContent).not.toContain('37');
    expect(generateButton().disabled).toBe(true);
  });

  test('first estimate in flight: spinner shown, Generate disabled', async () => {
    renderFooter({ ...base, isLoading: true });
    await vi.waitFor(() => costButton());
    expect(costSpinning()).toBe(true);
    expect(generateButton().disabled).toBe(true);
  });

  test('re-estimate in flight over a known cost: spinner shown, Generate disabled', async () => {
    // A non-zero cost, so the spinner can only come from the in-flight flag, not from "no cost yet".
    renderFooter({ ...base, isLoading: true, total: 37 });
    await vi.waitFor(() => costButton());
    expect(costSpinning()).toBe(true);
    expect(generateButton().disabled).toBe(true);
  });

  test('estimate settled: cost shown, no spinner, Generate enabled', async () => {
    renderFooter({ ...base, total: 37 });
    await vi.waitFor(() => costButton());
    expect(costSpinning()).toBe(false);
    expect(costButton().textContent).toContain('37');
    expect(costButton().textContent).not.toContain('–');
    expect(generateButton().disabled).toBe(false);
  });
});
