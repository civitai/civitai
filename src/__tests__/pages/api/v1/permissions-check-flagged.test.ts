import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as CommonService from '~/server/services/common.service';

const { mockHasEntityAccess, mockGetSessionUserById } = vi.hoisted(() => ({
  mockHasEntityAccess: vi.fn(),
  mockGetSessionUserById: vi.fn(),
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess: mockHasEntityAccess,
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: mockGetSessionUserById },
}));

import permissionsHandler from '~/pages/api/v1/permissions/check';

/**
 * The generation permission answered for a version of a model flagged `poi`: true only for the
 * model's owner and moderators, whatever the access grant says. Other versions keep the grant's
 * answer.
 */

const OWNER = 7;
const FLAGGED_VERSION = 100;
const CONTROL_VERSION = 200;

async function check(userId: number | undefined, isModerator = false) {
  mockGetSessionUserById.mockResolvedValue(userId ? { id: userId, isModerator } : null);
  mockHasEntityAccess.mockResolvedValue([
    { entityId: FLAGGED_VERSION, hasAccess: true },
    { entityId: CONTROL_VERSION, hasAccess: true },
  ]);
  dbMock.dbRead.modelVersion.findMany.mockImplementation(async (args: any) =>
    args.where.model.poi === true && args.where.id.in.includes(FLAGGED_VERSION)
      ? [{ id: FLAGGED_VERSION, model: { userId: OWNER } }]
      : []
  );
  const req = {
    method: 'GET',
    headers: {},
    query: {
      entityIds: `${FLAGGED_VERSION},${CONTROL_VERSION}`,
      ...(userId ? { userId: String(userId) } : {}),
    },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await permissionsHandler(req as never, res as never);
  expect(res.status).not.toHaveBeenCalled();
  return res.json.mock.calls.at(-1)?.[0] as Record<string, boolean>;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /api/v1/permissions/check, flagged model versions', () => {
  it.each([
    ['no user', undefined, false],
    ['a non-owner', 8, false],
  ])('answers false for %s, and keeps the control version', async (_l, userId, isMod) => {
    expect(await check(userId, isMod)).toEqual({
      [FLAGGED_VERSION]: false,
      [CONTROL_VERSION]: true,
    });
  });

  it.each([
    ['the owner', OWNER, false],
    ['a moderator', 1, true],
  ])('keeps true for %s', async (_l, userId, isMod) => {
    expect(await check(userId, isMod)).toEqual({
      [FLAGGED_VERSION]: true,
      [CONTROL_VERSION]: true,
    });
  });
});
