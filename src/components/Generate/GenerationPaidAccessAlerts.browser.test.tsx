import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * The ticket's whole point is that the trial-exhausted error offered nothing. Two properties decide
 * whether it still does, and neither is visible to the pure gate tests: the alert must render a purchase
 * control, and that control must open the purchase modal for the right version.
 */

const { mockGates, triggered } = vi.hoisted(() => ({
  mockGates: vi.fn(),
  triggered: [] as Record<string, unknown>[],
}));

vi.mock('~/components/Generate/useGenerationPurchaseGates', () => ({
  useGenerationPurchaseGates: mockGates,
}));

vi.mock('~/components/Dialog/dialogStore', () => ({
  dialogStore: { trigger: (args: Record<string, unknown>) => triggered.push(args) },
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ earlyAccessModel: true }),
}));

// The modal is only ever passed by reference here, so a stub keeps its provider tree out of this test.
vi.mock('~/components/Model/ModelVersions/ModelVersionEarlyAccessPurchase', () => ({
  ModelVersionEarlyAccessPurchase: () => null,
}));

const { TrialAccessWarning, TrialBlockedAlert } = await import('./GenerationPaidAccessAlerts');
const { IsClientProvider, useIsClient } = await import('~/providers/IsClientProvider');

// `DismissibleAlert` renders nothing until IsClientProvider's effect has flipped, so an absence
// assertion made before that would pass against a tree that never had a chance to draw. This probe is
// the positive control: once it reads "client", the warning has had its render.
const ClientProbe = () => (
  <span data-testid="client-probe">{useIsClient() ? 'client' : 'ssr'}</span>
);

const gate = (modelVersionId: number, modelName: string) => ({
  modelVersionId,
  modelId: modelVersionId * 10,
  modelName,
  versionName: 'v1',
  price: 200,
});

beforeEach(() => {
  vi.clearAllMocks();
  triggered.length = 0;
});

describe('TrialBlockedAlert', () => {
  test('offers the purchase for the version the message names, and opens it for that id', async () => {
    mockGates.mockReturnValue({
      gates: [gate(7, 'Sulphur'), gate(9, 'HappyHorse')],
      isLoading: false,
    });

    renderWithProviders(
      <TrialBlockedAlert
        selectedIds={[]}
        message="You have 0 trial generations remaining with HappyHorse"
        onClose={() => undefined}
      />
    );

    const button = page.getByRole('button', { name: /get access/i });
    await expect.element(button).toBeInTheDocument();
    await button.click();

    expect(triggered).toHaveLength(1);
    expect(triggered[0].props).toEqual({ modelVersionId: 9, reason: 'generation' });
  });

  /**
   * The case that shipped wrong: 1 trial left, quantity 4, so the whatIf refuses. The allowance is not
   * spent — telling the user it is hides the free remedy (generate fewer) and is simply false.
   */
  test('names the free remedy when the block is about quantity, not exhaustion', async () => {
    mockGates.mockReturnValue({ gates: [gate(7, 'Luicelia Superdia')], isLoading: false });

    renderWithProviders(
      <TrialBlockedAlert
        selectedIds={[]}
        message="You have 1 trial generations remaining with Luicelia Superdia - v1.0"
        remaining={1}
      />
    );

    await expect
      .element(page.getByText(/Lower the quantity to 1/, { exact: false }))
      .toBeInTheDocument();
    expect(page.getByText(/used up/).elements()).toHaveLength(0);
    // The purchase is still offered — it is the other way out of the same block.
    await expect.element(page.getByRole('button', { name: /get access/i })).toBeInTheDocument();
  });

  test('says used up only when the allowance is actually spent', async () => {
    mockGates.mockReturnValue({ gates: [gate(7, 'Sulphur')], isLoading: false });

    renderWithProviders(
      <TrialBlockedAlert
        selectedIds={[]}
        message="You have 0 trial generations remaining with Sulphur"
        remaining={0}
      />
    );

    await expect.element(page.getByText(/are used up/, { exact: false })).toBeInTheDocument();
    expect(page.getByText(/Lower the quantity/).elements()).toHaveLength(0);
  });

  test('falls back to the raw message with no offer when nothing is sellable', async () => {
    mockGates.mockReturnValue({ gates: [], isLoading: false });

    renderWithProviders(
      <TrialBlockedAlert
        selectedIds={[]}
        message="You have 0 trial generations remaining"
        onClose={() => undefined}
      />
    );

    await expect
      .element(page.getByText('You have 0 trial generations remaining'))
      .toBeInTheDocument();
    // The dead end is preserved rather than guessed at — offering the wrong model's purchase is worse.
    expect(page.getByRole('button', { name: /get access/i }).elements()).toHaveLength(0);
  });
});

describe('TrialAccessWarning', () => {
  const renderWarning = () =>
    renderWithProviders(
      <IsClientProvider>
        <TrialAccessWarning selectedIds={[]} />
        <ClientProbe />
      </IsClientProvider>
    );

  test('warns before the wall, naming the paid resource', async () => {
    mockGates.mockReturnValue({ gates: [gate(7, 'Sulphur')], isLoading: false });

    renderWarning();

    await expect.element(page.getByText(/Sulphur is a paid resource/)).toBeInTheDocument();
    await page.getByRole('button', { name: /get access/i }).click();
    expect(triggered[0].props).toEqual({ modelVersionId: 7, reason: 'generation' });
  });

  test('shows the real remaining count when the orchestrator reported one', async () => {
    mockGates.mockReturnValue({ gates: [gate(7, 'Sulphur')], isLoading: false });

    renderWithProviders(
      <IsClientProvider>
        <TrialAccessWarning selectedIds={[]} remaining={1} />
        <ClientProbe />
      </IsClientProvider>
    );

    // Singular at 1 — the count is the whole point of the warning, so a plural here reads as a bug.
    await expect
      .element(page.getByText('1 free trial generation left with Sulphur', { exact: false }))
      .toBeInTheDocument();
  });

  test('renders nothing when no selected resource is sold', async () => {
    mockGates.mockReturnValue({ gates: [], isLoading: false });

    renderWarning();

    await expect.element(page.getByTestId('client-probe')).toHaveTextContent('client');
    expect(page.getByRole('button', { name: /get access/i }).elements()).toHaveLength(0);
    expect(page.getByText(/paid resource/).elements()).toHaveLength(0);
  });
});
