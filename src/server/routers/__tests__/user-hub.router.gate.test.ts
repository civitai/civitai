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
  getHubSourceSuggestions: vi.fn().mockResolvedValue([]),
  resolveHubSourceFromUrl: vi.fn().mockResolvedValue(null),
  addUserHubSource: vi.fn().mockResolvedValue({ hubId: 1, added: true }),
  removeUserHubSource: vi.fn().mockResolvedValue({ hubId: 1, removed: true }),
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
  sourceSuggestions: { type: 'User', query: 'a' },
  resolveSource: { url: 'https://civitai.com/user/someone' },
  addSource: { hubId: 1, type: 'User', targetId: 2 },
  removeSource: { hubId: 1, type: 'User', targetId: 2 },
};

const procedureNames = Object.keys(
  (userHubRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures
);

const caller = (tokenScope: number = TokenScope.Full, apiKeyId: number | null = null) =>
  userHubRouter.createCaller({
    user: { id: 7, isModerator: false },
    ip: '1.2.3.4',
    acceptableOrigin: true,
    tokenScope,
    apiKeyId,
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

/**
 * The scope gate, which the suite above cannot see: its caller carries
 * `TokenScope.Full`, and `enforceTokenScope` skips the check outright for Full. So
 * deleting `.meta({ requiredScope })` from a hub procedure — which downgrades it to
 * the implicit Full requirement, locking every scoped token out — passes every test
 * above, and so does swapping a write procedure's scope for the read one.
 *
 * Hubs have no scope of their own; they ride on `UserRead` / `UserWrite`. The map is
 * written out by hand rather than read off the router, because a map derived from
 * `.meta()` asserts the router against itself and passes whatever it says.
 */
const requiredScopes: Record<string, number> = {
  getAll: TokenScope.UserRead,
  getById: TokenScope.UserRead,
  sourceSuggestions: TokenScope.UserRead,
  resolveSource: TokenScope.UserRead,
  upsert: TokenScope.UserWrite,
  addSource: TokenScope.UserWrite,
  removeSource: TokenScope.UserWrite,
  delete: TokenScope.UserWrite,
  setOrder: TokenScope.UserWrite,
};

// `UserRead` and `UserWrite` are independent bits, so each is the other's negative
// control: a read-scoped token must be refused every write procedure and vice versa.
const otherScope = (scope: number) =>
  scope === TokenScope.UserRead ? TokenScope.UserWrite : TokenScope.UserRead;

describe('every hub procedure declares the scope it needs', () => {
  beforeEach(() => {
    getFeatureFlagsMock.mockReturnValue({ userHubs: true });
  });

  it('covers every procedure the router actually exposes', () => {
    expect(procedureNames.slice().sort()).toEqual(Object.keys(requiredScopes).sort());
  });

  for (const name of procedureNames) {
    const scope = requiredScopes[name];

    it(`${name} accepts a token scoped to exactly what it declares`, async () => {
      await expect(caller(scope, 999)[name](inputs[name])).resolves.not.toThrow();
    });

    it(`${name} refuses a token carrying only the other user scope`, async () => {
      await expect(caller(otherScope(scope), 999)[name](inputs[name])).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  }
});
