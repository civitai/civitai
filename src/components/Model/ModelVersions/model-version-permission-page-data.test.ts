import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';

/**
 * `useModelVersionPermission` on the model page reads the version the page already holds from
 * `model.getById` instead of refetching it through `modelVersion.getById`. Only a caller that has no
 * model data on hand (the purchase modal opened from the generator) still fetches.
 *
 * The viewer-specific half of the answer — whether THIS user bought download/generation access —
 * comes from `common.getEntityAccess` on both paths, which is the query a purchase or a goal-reaching
 * donation invalidates. So the page path must keep that query enabled without waiting on a
 * `modelVersion.getById` response that it no longer issues.
 */

const VERSION_ID = 4711;
const OWNER_ID = 8101;
const VIEWER_ID = 6203;
const ACCESS_KEY = { entityId: [VERSION_ID], entityType: 'ModelVersion' };

// Distinct from every default the hook returns while it has no version: not downloadable, not
// selectable in the generator, a live gate, and terms with no free trial.
const pageVersion = {
  id: VERSION_ID,
  usageControl: 'InternalGeneration',
  canGenerate: true,
  paidAccess: {
    endsAt: new Date('2999-01-01T00:00:00.000Z'),
    timeframeDays: 7,
    terms: { download: { price: 500 }, generation: { price: 200, trialLimit: 0 } },
    sale: null,
  },
  model: { id: 9001, type: 'LORA', user: { id: OWNER_ID } },
};

const state = vi.hoisted(() => ({
  currentUser: null as { id: number; isModerator?: boolean } | null,
  entityAccess: undefined as unknown,
  fetchedVersion: undefined as unknown,
}));

const spies = vi.hoisted(() => ({
  getByIdUseQuery: vi.fn(),
  entityAccessUseQuery: vi.fn(),
  entityAccessInvalidate: vi.fn(),
  earlyAccessUseMutation: vi.fn((..._args: unknown[]) => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  donateUseMutation: vi.fn((..._args: unknown[]) => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy(
      {
        'modelVersion.getById': { useQuery: spies.getByIdUseQuery },
        'common.getEntityAccess': { useQuery: spies.entityAccessUseQuery },
        'modelVersion.earlyAccessPurchase': { useMutation: spies.earlyAccessUseMutation },
        'donationGoal.donate': { useMutation: spies.donateUseMutation },
      },
      {
        useUtils: () => ({
          common: { getEntityAccess: { invalidate: spies.entityAccessInvalidate } },
          modelVersion: { donationGoal: { invalidate: vi.fn(), setData: vi.fn() } },
        }),
      }
    ),
  };
});

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => state.currentUser }));

import * as permissionModule from '~/components/Model/ModelVersions/model-version.utils';
import { useMutateDonationGoal } from '~/components/DonationGoal/donation-goal.util';

const { modelVersionAccessInput, useModelVersionPermission, useMutateModelVersion } =
  permissionModule;

type HookArgs = Parameters<typeof useModelVersionPermission>[0];
// The cast keeps this file compiling against a hook signature that predates the `modelVersion` input.
const useFromPage = () =>
  useModelVersionPermission({ modelVersionId: VERSION_ID, modelVersion: pageVersion } as HookArgs);

const getByIdOptions = () =>
  spies.getByIdUseQuery.mock.calls.map((call) => call[1] as { enabled?: boolean });
const entityAccessCalls = () =>
  spies.entityAccessUseQuery.mock.calls.map(
    (call) => ({ input: call[0], enabled: (call[1] as { enabled?: boolean }).enabled } as const)
  );

beforeEach(() => {
  vi.clearAllMocks();
  state.currentUser = { id: VIEWER_ID };
  state.entityAccess = undefined;
  state.fetchedVersion = undefined;
  spies.getByIdUseQuery.mockImplementation((_input: unknown, opts?: { enabled?: boolean }) => ({
    data: opts?.enabled === false ? undefined : state.fetchedVersion,
  }));
  spies.entityAccessUseQuery.mockImplementation(
    (_input: unknown, opts?: { enabled?: boolean }) => ({
      data: opts?.enabled === false ? undefined : state.entityAccess,
      isLoading: false,
    })
  );
});

describe('model page path — the version comes from the page, not modelVersion.getById', () => {
  it('never enables a modelVersion.getById request', () => {
    useFromPage();

    // The hook must still CALL the query hook (rules of hooks) — but disabled.
    expect(spies.getByIdUseQuery).toHaveBeenCalledTimes(1);
    expect(getByIdOptions()).toEqual([expect.objectContaining({ enabled: false })]);
  });

  it('queries entity access straight away, with the key a purchase invalidates', () => {
    useFromPage();

    expect(entityAccessCalls()).toEqual([{ input: ACCESS_KEY, enabled: true }]);
  });

  it('derives every permission from the page data for a non-owner who has not bought', () => {
    state.entityAccess = [];

    const result = useFromPage();

    // Falsy, not `false`: for a non-owner non-moderator the hook yields `false || undefined`
    // (pre-existing); every consumer reads it as a boolean. The no-version default is `true`.
    expect(result.isDownloadable).toBeFalsy();
    expect(result.isSelectableInGenerator).toBe(false);
    expect(result.isEarlyAccess).toBe(true);
    expect(result.canDownload).toBeFalsy();
    expect(result.canGenerate).toBe(false);
    expect(result.generationRequiresPurchase).toBe(true);
    expect(result.paidAccess).toBe(pageVersion.paidAccess);
    expect(result.modelVersion).toBe(pageVersion);
  });

  it('reads ownership from the page model: only the owner may download a non-Download version', () => {
    // The fixture's usageControl is InternalGeneration, so ownership alone decides isDownloadable.
    // OWNER_ID, VIEWER_ID and the model id are pairwise distinct, so reading the wrong id (or
    // ignoring ownership, or falling back to the no-version default of `true`) flips one of the two.
    state.entityAccess = [];

    state.currentUser = { id: VIEWER_ID };
    expect(useFromPage().isDownloadable).toBeFalsy();

    state.currentUser = { id: OWNER_ID };
    expect(useFromPage().isDownloadable).toBe(true);
  });

  it('a version id that disagrees with the page data falls back to fetching', () => {
    // Invariant guard: a stale page object must never answer for a different version.
    useModelVersionPermission({
      modelVersionId: VERSION_ID + 1,
      modelVersion: pageVersion,
    } as HookArgs);

    expect(spies.getByIdUseQuery.mock.calls[0]?.[0]).toEqual({ id: VERSION_ID + 1 });
    expect(getByIdOptions()).toEqual([expect.objectContaining({ enabled: true })]);
  });
});

describe('a purchase refreshes the page-path permission state', () => {
  it('flips download + generation once entity access reports the purchase', () => {
    state.entityAccess = [];
    const before = useFromPage();
    expect(before.canDownload).toBeFalsy();
    expect(before.canGenerate).toBe(false);

    // What the refetch of the invalidated getEntityAccess entry returns after buying both tiers.
    state.entityAccess = [{ entityId: VERSION_ID, hasAccess: true, permissions: 3 }];
    const after = useFromPage();

    expect(after.canDownload).toBe(true);
    expect(after.canGenerate).toBe(true);
    expect(after.generationRequiresPurchase).toBe(false);
  });

  it('the purchase mutation invalidates exactly the entry the page path reads', () => {
    useFromPage();
    useMutateModelVersion();
    const opts = spies.earlyAccessUseMutation.mock.calls[0]?.[0] as {
      onSuccess: (data: unknown, input: { modelVersionId: number }) => void;
    };

    opts.onSuccess(undefined, { modelVersionId: VERSION_ID });

    expect(spies.entityAccessInvalidate).toHaveBeenCalledWith(ACCESS_KEY);
    expect(entityAccessCalls()).toEqual([{ input: ACCESS_KEY, enabled: true }]);
  });

  it('a donation that meets the goal invalidates that same entry', async () => {
    // Invariant guard (green before this change too): the donation path never touched
    // modelVersion.getById, so moving the page off it loses nothing here.
    useMutateDonationGoal();
    const opts = spies.donateUseMutation.mock.calls[0]?.[0] as {
      onSuccess: (data: unknown, input: { donationGoalId: number }) => Promise<void>;
    };

    await opts.onSuccess(
      { entityType: 'ModelVersion', entityId: VERSION_ID, total: 1000, goalAmount: 1000 },
      { donationGoalId: 77 }
    );

    expect(spies.entityAccessInvalidate).toHaveBeenCalledWith(modelVersionAccessInput(VERSION_ID));
    expect(modelVersionAccessInput(VERSION_ID)).toEqual(ACCESS_KEY);
  });
});

describe('standalone path — no page data, so the hook fetches', () => {
  it('enables modelVersion.getById for the version and derives from its response', () => {
    // Invariant guard (green before this change too): the generator's purchase modal keeps working.
    state.fetchedVersion = { ...pageVersion, usageControl: 'Download' };
    state.entityAccess = [{ entityId: VERSION_ID, hasAccess: true, permissions: 2 }];

    const result = useModelVersionPermission({ modelVersionId: VERSION_ID });

    expect(spies.getByIdUseQuery.mock.calls[0]?.[0]).toEqual({ id: VERSION_ID });
    expect(getByIdOptions()).toEqual([expect.objectContaining({ enabled: true })]);
    expect(result.isDownloadable).toBe(true);
    expect(result.canDownload).toBe(true);
    expect(result.canGenerate).toBe(false);
    expect(result.modelVersion).toBe(state.fetchedVersion);
  });

  it('issues no request at all without a version id', () => {
    useModelVersionPermission({});

    expect(getByIdOptions()).toEqual([expect.objectContaining({ enabled: false })]);
  });
});

describe('toModelVersionPermissionData — the page shape the hook is fed', () => {
  it('maps a model.getById model + version onto the fields the hook reads', () => {
    // Read through the namespace so a missing export fails THIS test, not the whole file.
    const toData = (permissionModule as unknown as Record<string, unknown>)
      .toModelVersionPermissionData as (model: unknown, version: unknown) => unknown;
    expect(typeof toData).toBe('function');

    const model = {
      id: 9001,
      type: 'LORA',
      name: 'unrelated',
      user: { id: OWNER_ID, username: 'unrelated' },
    };
    const version = {
      id: VERSION_ID,
      name: 'unrelated',
      usageControl: 'InternalGeneration',
      canGenerate: true,
      paidAccess: pageVersion.paidAccess,
    };

    expect(toData(model, version)).toEqual({
      id: VERSION_ID,
      usageControl: 'InternalGeneration',
      canGenerate: true,
      paidAccess: pageVersion.paidAccess,
      model: { id: 9001, type: 'LORA', user: { id: OWNER_ID } },
    });
  });
});
