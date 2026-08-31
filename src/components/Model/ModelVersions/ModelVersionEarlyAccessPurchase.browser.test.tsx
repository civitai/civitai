import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * The buyer-facing half of the Blue Buzz opt-in. Two properties matter here, and neither is visible
 * to the server tests:
 *
 *  1. A creator who did NOT opt in must be offered exactly one button. An extra one would send a
 *     purchase the server rejects.
 *  2. The Blue button must carry `exactAccountTypes={['blue']}`. `BuzzTransactionButton` DISTRIBUTES
 *     a spend across whatever account types it's given and `useAvailableBuzz` appends the domain
 *     currency, so plain `accountTypes={['blue']}` would check a blue+green balance while the server
 *     charges blue alone — affordable on screen, insufficient on submit.
 */

const { mockPurchase, buttonProps } = vi.hoisted(() => ({
  mockPurchase: vi.fn(),
  buttonProps: [] as Record<string, unknown>[],
}));

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn(), zIndex: 200 }),
}));

// Stubbed at the seam rather than mocked away: the real button needs live balance queries, but the
// props it receives ARE the client contract under test, so they're recorded verbatim.
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: (props: Record<string, unknown>) => {
    buttonProps.push(props);
    return (
      <button
        type="button"
        data-testid="buzz-button"
        onClick={props.onPerformTransaction as () => void}
      >
        {props.label as string}
      </button>
    );
  },
}));

vi.mock('~/components/ImageGeneration/utils/generationRequestHooks', () => ({
  useInvalidateWhatIf: () => vi.fn(),
}));

vi.mock('~/components/RunStrategy/GenerateButton', () => ({
  GenerateButton: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { mockPermission } = vi.hoisted(() => ({ mockPermission: vi.fn() }));

vi.mock('~/components/Model/ModelVersions/model-version.utils', () => ({
  useModelVersionPermission: mockPermission,
  useMutateModelVersion: () => ({
    modelVersionEarlyAccessPurchase: mockPurchase,
    purchasingModelVersionEarlyAccess: false,
  }),
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ imageGeneration: true, isGreen: true, buzz: true }),
}));

const { ModelVersionEarlyAccessPurchase } = await import('./ModelVersionEarlyAccessPurchase');

const seedPermission = (acceptsBlueBuzz: boolean) =>
  mockPermission.mockReturnValue({
    isLoadingAccess: false,
    canDownload: false,
    generationRequiresPurchase: true,
    paidAccess: {
      // Permanent gate: a timed one renders a Countdown, which needs IsClientProvider. The buttons
      // under test are identical either way, so the gate kind is incidental here.
      endsAt: null,
      timeframeDays: null,
      terms: {
        download: { price: 500 },
        generation: { price: 200 },
        ...(acceptsBlueBuzz ? { acceptsBlueBuzz: true } : {}),
      },
    },
    modelVersion: { canGenerate: true, model: { id: 1, type: 'Checkpoint' } },
  });

beforeEach(() => {
  vi.clearAllMocks();
  buttonProps.length = 0;
});

describe('ModelVersionEarlyAccessPurchase — Blue Buzz opt-in', () => {
  test('offers one button per tier when the creator has not opted in', async () => {
    seedPermission(false);
    renderWithProviders(<ModelVersionEarlyAccessPurchase modelVersionId={1} />);

    await expect
      .element(page.getByRole('button', { name: 'Get Download Access' }))
      .toBeInTheDocument();
    // Download + generation, and no currency is named because there's no choice to make.
    expect(page.getByTestId('buzz-button').elements()).toHaveLength(2);
    expect(buttonProps.some((p) => p.exactAccountTypes)).toBe(false);
  });

  test('offers a Blue and a domain button per tier when the creator opted in', async () => {
    seedPermission(true);
    renderWithProviders(<ModelVersionEarlyAccessPurchase modelVersionId={1} />);

    await expect
      .element(page.getByRole('button', { name: 'Get Download Access with Green Buzz' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Get Download Access with Blue Buzz' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Get Generation Access with Blue Buzz' }))
      .toBeInTheDocument();
    expect(page.getByTestId('buzz-button').elements()).toHaveLength(4);
  });

  test('the Blue button spends blue ALONE, never blue plus the domain currency', async () => {
    seedPermission(true);
    renderWithProviders(<ModelVersionEarlyAccessPurchase modelVersionId={1} />);
    await expect
      .element(page.getByRole('button', { name: 'Get Download Access with Blue Buzz' }))
      .toBeInTheDocument();

    const blue = buttonProps.filter((p) => (p.label as string).includes('Blue Buzz'));
    expect(blue).toHaveLength(2);
    for (const props of blue) {
      expect(props.exactAccountTypes).toEqual(['blue']);
      expect(props.colorType).toBe('blue');
    }
    // The domain buttons must NOT pin an exact set — they ride the normal domain resolution.
    const domain = buttonProps.filter((p) => (p.label as string).includes('Green Buzz'));
    expect(domain).toHaveLength(2);
    for (const props of domain) expect(props.exactAccountTypes).toBeUndefined();
  });

  test('each button asks the server for the currency it advertises', async () => {
    seedPermission(true);
    renderWithProviders(<ModelVersionEarlyAccessPurchase modelVersionId={1} />);

    await page.getByRole('button', { name: 'Get Download Access with Blue Buzz' }).click();
    expect(mockPurchase).toHaveBeenCalledWith({
      modelVersionId: 1,
      type: 'download',
      payWithBlue: true,
    });

    await page.getByRole('button', { name: 'Get Generation Access with Green Buzz' }).click();
    expect(mockPurchase).toHaveBeenLastCalledWith({
      modelVersionId: 1,
      type: 'generation',
      payWithBlue: false,
    });
  });
});
