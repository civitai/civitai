import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CommonService from '~/server/services/common.service';
import type * as GenerationService from '~/server/services/generation/generation.service';

const { mockHasEntityAccess, mockGetSessionUserById, mockModsOnly } = vi.hoisted(() => ({
  mockHasEntityAccess: vi.fn(),
  mockGetSessionUserById: vi.fn(),
  mockModsOnly: vi.fn<(...args: unknown[]) => Promise<Set<number>>>(),
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess: mockHasEntityAccess,
}));
vi.mock('~/server/services/generation/generation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationService>()),
  getGateRuleState: vi.fn(async () => ({ known: true, value: [], source: 'live', ageMs: 0 })),
  getModsOnlyVersionIds: mockModsOnly,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: mockGetSessionUserById },
}));

import permissionsHandler from '~/pages/api/v1/permissions/check';

/**
 * The generation permission for a PoI version is false for everyone, its owner and moderators
 * included; for a mods-only version it is false for everyone but moderators. Other versions keep the
 * access grant's answer.
 */

const OWNER = 7;
const POI_VERSION = 100;
const CONTROL_VERSION = 200;
const MODS_ONLY_VERSION = 300;

async function check(userId: number | undefined, isModerator = false) {
  mockGetSessionUserById.mockResolvedValue(userId ? { id: userId, isModerator } : null);
  mockHasEntityAccess.mockResolvedValue(
    [POI_VERSION, CONTROL_VERSION, MODS_ONLY_VERSION].map((entityId) => ({
      entityId,
      hasAccess: true,
    }))
  );
  mockModsOnly.mockResolvedValue(new Set([MODS_ONLY_VERSION]));
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([
    { id: POI_VERSION, baseModel: 'SDXL 1.0', meta: null, model: { poi: true, userId: OWNER } },
    { id: CONTROL_VERSION, baseModel: 'SDXL 1.0', meta: null, model: { poi: false } },
    { id: MODS_ONLY_VERSION, baseModel: 'SDXL 1.0', meta: null, model: { poi: false } },
  ] as never);
  const req = {
    method: 'GET',
    headers: {},
    query: {
      entityIds: `${POI_VERSION},${CONTROL_VERSION},${MODS_ONLY_VERSION}`,
      ...(userId ? { userId: String(userId) } : {}),
    },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await permissionsHandler(req as never, res as never);
  expect(res.status).not.toHaveBeenCalled();
  return res.json.mock.calls.at(-1)?.[0] as Record<string, boolean>;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v1/permissions/check, PoI and mods-only versions', () => {
  it.each([
    ['no user', undefined],
    ['a non-owner', 8],
    ['the owner', OWNER],
  ])('refuses both to %s, and keeps the control version', async (_l, userId) => {
    expect(await check(userId)).toEqual({
      [POI_VERSION]: false,
      [CONTROL_VERSION]: true,
      [MODS_ONLY_VERSION]: false,
    });
  });

  it('refuses a moderator the PoI version only', async () => {
    expect(await check(1, true)).toEqual({
      [POI_VERSION]: false,
      [CONTROL_VERSION]: true,
      [MODS_ONLY_VERSION]: true,
    });
  });
});
