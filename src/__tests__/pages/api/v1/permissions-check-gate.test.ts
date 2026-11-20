import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import type * as CommonService from '~/server/services/common.service';
import type * as KeyGenerator from '~/server/utils/key-generator';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type { GateRule } from '~/shared/generation/gates';
import { baseModelByName, ecosystemById } from '~/shared/constants/basemodel.constants';
import {
  CLIENT_CREDENTIALS_ONLY_SCOPES,
  TokenScope,
} from '~/shared/constants/token-scope.constants';

// The caller is resolved by the real session and bearer-key code; only storage is faked.
const { mockHasEntityAccess, getSessionUserById, isTester } = vi.hoisted(() => ({
  mockHasEntityAccess: vi.fn(),
  getSessionUserById: vi.fn(),
  isTester: vi.fn(),
}));

// Flipt is a network service; the tester segment is the only part of it the gate reads.
vi.mock('~/server/flipt/tester-segment', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isFliptOnForTesters: isTester,
}));

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PublicEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess: mockHasEntityAccess,
}));
vi.mock('~/server/auth/session-client', () => ({ sessionClient: { getSessionUserById } }));
vi.mock('~/server/utils/key-generator', async (importOriginal) => ({
  ...(await importOriginal<typeof KeyGenerator>()),
  generateSecretHash: (key: string) => key,
}));

import permissionsHandler from '~/pages/api/v1/permissions/check';
import { __resetGenerationConfigLastKnownForTests } from '~/server/services/generation/generation.service';

const VERSION = 100;
const ASKED = 7;
const OTHER = 8;
const SERVICE = -1;

type Owner = { id: number; isModerator?: boolean; bannedAt?: Date; meta?: unknown };
let users: Record<number, Owner> = {};

function keyFor(owner: Owner, tokenScope: bigint = TokenScope.ModelsRead) {
  users[owner.id] = owner;
  dbMock.dbWrite.apiKey.findFirst.mockResolvedValue({
    id: 1,
    userId: owner.id,
    tokenScope,
    lastUsedAt: new Date(),
    buzzLimit: null,
    clientId: null,
    type: 'System',
    expiresAt: null,
  } as never);
}

async function ask(authorization?: string, entityIds = String(VERSION)) {
  const req = {
    method: 'GET',
    headers: authorization ? { authorization } : {},
    cookies: {},
    query: { entityIds, userId: String(ASKED) },
  };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
    getHeader: vi.fn(),
  };
  await permissionsHandler(req as never, res as never);
  lastRes = res;
  return res.json.mock.calls.at(-1)?.[0];
}
let lastRes: { setHeader: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };

// The gate rules live in a sysRedis hash, one JSON entry per rule.
let storedRules: GateRule[] = [];
let rulesReadable = true;
function seedGateRules() {
  const { sysRedis } = redisMock;
  sysRedis.get.mockResolvedValue('1');
  sysRedis.hGetAll.mockImplementation(async () => {
    if (!rulesReadable) throw new Error('sysRedis down');
    return Object.fromEntries(storedRules.map((r) => [r.id, JSON.stringify(r)]));
  });
}
const rule = (over: Partial<GateRule>): GateRule => ({
  id: 'gate',
  name: '',
  availableTo: 'members',
  presentation: 'hidden',
  message: null,
  ecosystems: [],
  workflows: [],
  modelVersionIds: [],
  ...over,
});

const BASE_MODEL = 'SDXL 1.0';
const ECOSYSTEM = ecosystemById.get(baseModelByName.get(BASE_MODEL)!.ecosystemId)!.key;
const ALIAS_TARGET = 300;
let versionRows: { id: number; baseModel: string; meta: unknown }[] = [];
const cacheHeader = () =>
  lastRes.setHeader.mock.calls.filter(([name]) => name === 'Cache-Control').at(-1)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
  users = { [ASKED]: { id: ASKED } };
  getSessionUserById.mockImplementation(async (id: number) =>
    users[id] ? { roles: [], ...users[id] } : null
  );
  // Only the asked-about user holds access, so `true` means the gate let the question through.
  mockHasEntityAccess.mockImplementation(async ({ userId }: { userId?: number }) => [
    { entityId: VERSION, hasAccess: userId === ASKED },
  ]);
  versionRows = [];
  // The PoI pass asks for model.poi rows (none here); every other read is the gate's version lookup.
  dbMock.dbRead.modelVersion.findMany.mockImplementation((async (args: {
    where: { id: { in: number[] }; model?: unknown };
  }) =>
    args.where.model ? [] : versionRows.filter((v) => args.where.id.in.includes(v.id))) as never);
  dbMock.dbWrite.apiKey.findFirst.mockResolvedValue(null as never);
  setEnv({ PERMISSIONS_CHECK_GATE: true, PERMISSIONS_CHECK_SERVICE_USER_IDS: [SERVICE] });
  storedRules = [];
  rulesReadable = true;
  seedGateRules();
  isTester.mockResolvedValue(false);
  __resetGenerationConfigLastKnownForTests();
});

describe('GET /api/v1/permissions/check with PERMISSIONS_CHECK_GATE', () => {
  it('answers about the given user for anyone while the switch is off', async () => {
    setEnv({ PERMISSIONS_CHECK_GATE: false });
    expect(await ask()).toEqual({ [VERSION]: true });
  });

  it('answers without the user for a caller with no credential, kept out of shared caches', async () => {
    expect(await ask()).toEqual({ [VERSION]: false });
    expect(cacheHeader()).toBe('private, no-store');
    expect(mockHasEntityAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined })
    );
  });

  it('answers without the user for another user', async () => {
    keyFor({ id: OTHER });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
  });

  it('answers a user asking about themself', async () => {
    keyFor({ id: ASKED });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
    expect(cacheHeader()).toBe('private, no-store');
  });

  it('answers a listed account without the moderator flag', async () => {
    keyFor({ id: SERVICE });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
  });

  it('answers a read-only key owned by a listed system account', async () => {
    keyFor({ id: SERVICE, meta: { systemAccount: true } });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
  });

  it('answers a moderator who is not listed', async () => {
    keyFor({ id: OTHER, isModerator: true });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
  });

  it('answers without the user for a client-credentials token, as session auth refuses it', async () => {
    keyFor({ id: SERVICE }, CLIENT_CREDENTIALS_ONLY_SCOPES);
    expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
  });

  it('answers without the user for a banned owner', async () => {
    keyFor({ id: SERVICE, bannedAt: new Date() });
    expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
  });

  it('answers without the user for a key that resolves to nobody', async () => {
    expect(await ask('Bearer nope')).toEqual({ [VERSION]: false });
  });
});

describe('GET /api/v1/permissions/check with generation gate rules', () => {
  beforeEach(() => {
    versionRows = [{ id: VERSION, baseModel: BASE_MODEL, meta: null }];
    keyFor({ id: ASKED });
  });

  it.each([
    ['hidden', 'members'],
    ['disabled', 'members'],
    ['hidden', 'moderators'],
    ['disabled', 'testers'],
    ['hidden', 'nobody'],
  ] as const)(
    'refuses a free user a version under a %s rule for %s',
    async (presentation, availableTo) => {
      storedRules = [rule({ presentation, availableTo, modelVersionIds: [VERSION] })];
      expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
      expect(cacheHeader()).toBe('private, no-store');
    }
  );

  it('lets a member through a members rule', async () => {
    users[ASKED] = { id: ASKED, tier: 'gold' } as Owner;
    storedRules = [rule({ availableTo: 'members', modelVersionIds: [VERSION] })];
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
  });

  it('lets a tester through a testers rule', async () => {
    isTester.mockResolvedValue(true);
    storedRules = [rule({ availableTo: 'testers', modelVersionIds: [VERSION] })];
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
  });

  it('lets a moderator through a moderators rule but not a nobody rule', async () => {
    users[ASKED] = { id: ASKED, isModerator: true };
    storedRules = [rule({ availableTo: 'moderators', modelVersionIds: [VERSION] })];
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
    storedRules = [rule({ availableTo: 'nobody', modelVersionIds: [VERSION] })];
    expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
  });

  it("matches a rule on the version's ecosystem", async () => {
    storedRules = [rule({ availableTo: 'moderators', ecosystems: [ECOSYSTEM] })];
    expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
  });

  it("matches a rule on an alias's target", async () => {
    versionRows = [
      {
        id: VERSION,
        baseModel: BASE_MODEL,
        meta: { generationAlias: { versionId: ALIAS_TARGET } },
      },
      { id: ALIAS_TARGET, baseModel: BASE_MODEL, meta: null },
    ];
    storedRules = [rule({ availableTo: 'moderators', modelVersionIds: [ALIAS_TARGET] })];
    expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
  });

  it('does not gate on an experimental rule', async () => {
    storedRules = [rule({ presentation: 'experimental', modelVersionIds: [VERSION] })];
    expect(await ask('Bearer k')).toEqual({ [VERSION]: true });
  });

  it('with the caller switch off, still answers an untrusted caller as anonymous for gated versions', async () => {
    setEnv({ PERMISSIONS_CHECK_GATE: false });
    users[ASKED] = { id: ASKED, tier: 'gold' } as Owner;
    keyFor({ id: OTHER });
    storedRules = [rule({ availableTo: 'members', modelVersionIds: [VERSION] })];
    expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
  });

  it('refuses a non-moderator while the rules have never been read', async () => {
    rulesReadable = false;
    expect(await ask('Bearer k')).toEqual({ [VERSION]: false });
  });

  it('refuses more than 100 versions in one call', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
    await ask('Bearer k', ids);
    expect(lastRes.status).toHaveBeenCalledWith(400);
  });
});
