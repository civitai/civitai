import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * `modelVersion.donationGoal` is requested only where its answer can change what renders.
 *
 *  - `ModelVersionDonationGoal` renders nothing while the `donationGoals` flag is off, so the
 *    request is enabled only with the flag on.
 *  - `EarlyAccessAlert` reads the goal only below its `!inEarlyAccess` early return, so the request
 *    is enabled only in early access. It is NOT gated on `donationGoals`: with that flag off the
 *    alert still says the version unlocks "once the donation goal is met", and the last arm pins it.
 *
 * The query spy mimics react-query: a disabled query returns no data. Every arm asserts the
 * `enabled` option the component passed (the hook is always called — rules of hooks) AND what
 * rendered, so a gate that also changed output would fail here too.
 */

const VERSION_ID = 4711;

const state = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  goal: null as unknown,
}));

const spies = vi.hoisted(() => ({ donationGoalUseQuery: vi.fn() }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({ 'modelVersion.donationGoal': { useQuery: spies.donationGoalUseQuery } }),
  };
});

vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => state.flags }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) => children,
}));
// The real Countdown needs IsClientProvider; the time it shows is incidental here.
vi.mock('~/components/Countdown/Countdown', () => ({ Countdown: () => <span>soon</span> }));
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

const { default: ModelVersionDonationGoal } = await import('./ModelVersionDonationGoal');
const { EarlyAccessAlert } = await import('~/components/Model/EarlyAccessAlert/EarlyAccessAlert');

const GOAL = {
  id: 77,
  title: 'Train the next version',
  description: null,
  goalAmount: 1000,
  total: 250,
  active: true,
  userId: 999,
  isEarlyAccess: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const enabledArgs = () =>
  spies.donationGoalUseQuery.mock.calls.map((call) => ({
    input: call[0],
    enabled: (call[1] as { enabled?: boolean } | undefined)?.enabled,
  }));

const FUTURE = new Date('2999-01-01T00:00:00.000Z');
const PAST = new Date('2000-01-01T00:00:00.000Z');

const renderAlert = (deadline?: Date) =>
  renderWithProviders(
    <EarlyAccessAlert modelId={1} versionId={VERSION_ID} modelType="LORA" deadline={deadline} />
  );

beforeEach(() => {
  vi.clearAllMocks();
  state.flags = {};
  state.goal = GOAL;
  spies.donationGoalUseQuery.mockImplementation(
    (_input: unknown, opts?: { enabled?: boolean }) => ({
      data: opts?.enabled === false ? undefined : state.goal,
      isLoading: false,
    })
  );
});

describe('ModelVersionDonationGoal — request only with the donationGoals flag on', () => {
  test('flag off: the request is disabled and nothing renders', async () => {
    state.flags = { donationGoals: false };
    await renderWithProviders(<ModelVersionDonationGoal modelVersionId={VERSION_ID} />);

    expect(spies.donationGoalUseQuery).toHaveBeenCalled();
    expect(new Set(enabledArgs().map((a) => a.enabled))).toEqual(new Set([false]));
    expect(page.getByText('Support this model').elements()).toHaveLength(0);
    expect(page.getByText('Train the next version').elements()).toHaveLength(0);
  });

  test('flag on: the request is enabled and the goal renders as before', async () => {
    state.flags = { donationGoals: true };
    await renderWithProviders(<ModelVersionDonationGoal modelVersionId={VERSION_ID} />);

    await expect.element(page.getByText('Support this model')).toBeInTheDocument();
    await expect.element(page.getByText('Train the next version')).toBeInTheDocument();
    expect(enabledArgs()).toContainEqual({ input: { id: VERSION_ID }, enabled: true });
    expect(enabledArgs().some((a) => a.enabled === false)).toBe(false);
  });
});

describe('EarlyAccessAlert — request only in early access', () => {
  test('not in early access (deadline passed): the request is disabled and nothing renders', async () => {
    state.flags = { earlyAccessModel: true, donationGoals: true };
    await renderAlert(PAST);

    expect(spies.donationGoalUseQuery).toHaveBeenCalled();
    expect(new Set(enabledArgs().map((a) => a.enabled))).toEqual(new Set([false]));
    expect(page.getByText(/Early Access/).elements()).toHaveLength(0);
  });

  test('no deadline: the request is disabled', async () => {
    state.flags = { earlyAccessModel: true, donationGoals: true };
    await renderAlert(undefined);

    expect(new Set(enabledArgs().map((a) => a.enabled))).toEqual(new Set([false]));
  });

  test('in early access: the request is enabled and the goal line renders', async () => {
    state.flags = { earlyAccessModel: true, donationGoals: true };
    await renderAlert(FUTURE);

    await expect.element(page.getByText(/once the donation goal is met/)).toBeInTheDocument();
    expect(enabledArgs()).toContainEqual({ input: { id: VERSION_ID }, enabled: true });
    expect(enabledArgs().some((a) => a.enabled === false)).toBe(false);
  });

  test('in early access with donationGoals OFF: still requested, goal line unchanged', async () => {
    state.flags = { earlyAccessModel: true, donationGoals: false };
    await renderAlert(FUTURE);

    await expect.element(page.getByText(/once the donation goal is met/)).toBeInTheDocument();
    expect(enabledArgs()).toContainEqual({ input: { id: VERSION_ID }, enabled: true });
  });

  test('in early access, no goal: the goal line is absent (control for the arms above)', async () => {
    state.flags = { earlyAccessModel: true, donationGoals: true };
    state.goal = null;
    await renderAlert(FUTURE);

    await expect.element(page.getByText(/Early Access/)).toBeInTheDocument();
    expect(page.getByText(/once the donation goal is met/).elements()).toHaveLength(0);
  });
});
