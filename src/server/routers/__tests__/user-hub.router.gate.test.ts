import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

/**
 * The flag gate has two halves and only one of them was asserted. `userHubs` being
 * false for every identity says nothing about whether the hub procedures READ it —
 * swap `userHubProcedure` back to `protectedProcedure`, or drop `.use(hasUserHubs)`,
 * and a suite that only checks the flag value stays entirely green while every hub
 * mutation is live for every logged-in user.
 *
 * The procedure list comes from the router itself rather than being typed out here,
 * because a hand-written list cannot catch the bug where someone adds a sixth
 * procedure and forgets the gate — which is the whole failure being guarded.
 */

const { getFeatureFlagsMock } = vi.hoisted(() => ({ getFeatureFlagsMock: vi.fn() }));

vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: getFeatureFlagsMock,
}));

vi.mock('~/server/services/user-hub.service', () => ({
  getUserHubs: vi.fn().mockResolvedValue([]),
  getUserHubById: vi.fn().mockResolvedValue({ id: 1 }),
  upsertUserHub: vi.fn().mockResolvedValue({ id: 1 }),
  deleteUserHub: vi.fn().mockResolvedValue(undefined),
  setUserHubOrder: vi.fn().mockResolvedValue(undefined),
}));

import { userHubRouter } from '~/server/routers/user-hub.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// One valid input per procedure. The KEYS are asserted against the router's own
// procedure list below, so adding a procedure without adding it here fails rather
// than silently going unexercised.
const inputs: Record<string, unknown> = {
  getAll: undefined,
  getById: { id: 1 },
  upsert: { name: 'a hub' },
  delete: { id: 1 },
  setOrder: { ids: [] },
};

const procedureNames = Object.keys(
  (userHubRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures
);

const caller = () =>
  userHubRouter.createCaller({
    user: { id: 7, isModerator: false },
    ip: '1.2.3.4',
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    features: {},
  } as never) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('every hub procedure is behind the userHubs flag', () => {
  it('covers every procedure the router actually exposes', () => {
    // The guard on the guard: without this, a procedure added later is simply
    // absent from the loop below and nothing reports it.
    expect(procedureNames.length).toBeGreaterThan(0);
    expect(procedureNames.slice().sort()).toEqual(Object.keys(inputs).sort());
  });

  for (const name of procedureNames) {
    it(`${name} refuses when the flag is off`, async () => {
      getFeatureFlagsMock.mockReturnValue({ userHubs: false });

      await expect(caller()[name](inputs[name])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it(`${name} runs when the flag is on`, async () => {
      // The control. Six refusals prove nothing on their own — a procedure that
      // throws for an unrelated reason (bad input shape, missing mock) refuses in
      // both states and reads as a working gate.
      getFeatureFlagsMock.mockReturnValue({ userHubs: true });

      await expect(caller()[name](inputs[name])).resolves.not.toThrow();
    });
  }
});
