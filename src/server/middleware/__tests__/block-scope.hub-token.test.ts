import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import '~/__tests__/setup';
import type { NextApiRequest, NextApiResponse } from 'next';

const { isFliptMock, fliptVariantMock, isRevokedMock, sessionMock } = vi.hoisted(() => ({
  isFliptMock: vi.fn(async (flag: string) => flag === 'app-blocks-runtime-enabled'),
  fliptVariantMock: vi.fn(async (): Promise<string | undefined> => undefined),
  isRevokedMock: vi.fn(async () => false),
  sessionMock: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { BEARER_SCOPE_TIGHTEN: 'bearer-scope-tighten' },
  isFlipt: isFliptMock,
  getFliptVariant: fliptVariantMock,
}));
const { viewerLevelMock, userOwnLevelMock } = vi.hoisted(() => ({
  viewerLevelMock: vi.fn(() => 3),
  // An author whose own level covers every level: the forced-SFW ceiling alone decides.
  userOwnLevelMock: vi.fn<(userId: number) => Promise<number>>(async () => 31),
}));
vi.mock('~/server/services/blocks/viewer-browsing-level', () => ({
  viewerEffectiveBrowsingLevel: viewerLevelMock,
  userOwnBrowsingLevel: userOwnLevelMock,
}));
vi.mock('~/server/services/block-revocation.service', () => ({
  BlockRevocation: { isRevoked: isRevokedMock },
}));
vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: sessionMock }));
const { tunnelMock } = vi.hoisted(() => ({ tunnelMock: vi.fn(async () => null as unknown) }));
vi.mock('~/server/services/blocks/dev-tunnel.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getActiveDevTunnel: (...a: unknown[]) => tunnelMock(...a),
}));

import { dbMock } from '~/__tests__/mocks';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { withBlockScope, type BlockScopedNextApiRequest } from '../block-scope.middleware';
import { BlockTokenService } from '~/server/services/block-token.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { FORCED_SFW_CEILING } from '~/server/services/blocks/dev-scoped-mint.service';
import { oauthScopeBitsFor } from '~/server/services/blocks/block-oauth-scope';

const USER_ID = 42;
const CLIENT_ID = 'app_hub';
const APP_BLOCK_ID = 'apb_hub';
const BLOCK_ID = 'blk_hub';
const SCOPE = 'user:read:self';

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
    setHeader() {
      return this;
    },
    removeHeader() {
      return undefined;
    },
    writeHead() {
      return this;
    },
    on() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & { statusCode: number; body: unknown };
}

async function drive(bearer: string) {
  let seen: BlockScopedNextApiRequest['blockClaims'];
  const handler = vi.fn(async (req: NextApiRequest, res: NextApiResponse) => {
    seen = (req as BlockScopedNextApiRequest).blockClaims;
    res.status(200).json({ via: 'handler' });
  });
  const route = withBlockScope(handler as never, { endpoint: 'me', requiredScope: SCOPE });
  const req = {
    method: 'GET',
    headers: { authorization: `Bearer ${bearer}` },
    query: {},
    url: '/api/v1/blocks/me',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as NextApiRequest;
  const res = makeRes();
  await route(req, res);
  return { handler, res, claims: seen };
}

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ APP_BLOCK_OAUTH_TOKENS_ENABLED: true });
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
  dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
    id: APP_BLOCK_ID,
    blockId: BLOCK_ID,
    manifest: { scopes: [SCOPE, 'apps:storage:read', 'buzz:read:self'] },
    approvedScopes: [SCOPE, 'apps:storage:read', 'buzz:read:self'],
  });
  dbMock.dbRead.appUserScopeGrant.findUnique.mockResolvedValue({
    grantedScopes: [SCOPE],
    revokedAt: null,
  });
});

describe('withBlockScope with a hub-issued OAuth token', () => {
  it('builds block claims from the viewer grant for a client that owns a block', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 99,
      subject: { type: 'oauth', id: CLIENT_ID },
    });

    const { res, claims } = await drive('civ_oauth_access_token');

    expect(res.statusCode).toBe(200);
    expect(claims).toMatchObject({
      sub: `user:${USER_ID}`,
      appId: CLIENT_ID,
      appBlockId: APP_BLOCK_ID,
      blockId: BLOCK_ID,
      blockInstanceId: `page_${APP_BLOCK_ID}`,
    });
    // 🔴 The viewer level is the viewer's own, intersected with this request's ceiling.
    expect(claims?.viewerBrowsingLevel).toBe(3);
    expect(viewerLevelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionUser: expect.objectContaining({ id: USER_ID }),
        maxBrowsingLevel: claims?.maxBrowsingLevel,
      })
    );
    // consent-exempt scopes ride along; the ungranted buzz scope is withheld
    expect([...(claims?.scopes ?? [])].sort()).toEqual(['apps:storage:read', SCOPE]);
    expect(dbMock.dbRead.appBlock.findFirst.mock.calls[0][0].where).toEqual({
      appId: CLIENT_ID,
      status: 'approved',
    });
  });

  describe('apps:storage:import on a hub token', () => {
    const IMPORT = 'apps:storage:import';
    const importingApp = (granted: string[]) => {
      sessionMock.mockResolvedValue({
        user: { id: USER_ID },
        apiKeyId: 31,
        subject: { type: 'oauth', id: CLIENT_ID },
      });
      dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
        id: APP_BLOCK_ID,
        blockId: BLOCK_ID,
        manifest: { scopes: [SCOPE, 'apps:storage', IMPORT] },
        approvedScopes: [SCOPE, 'apps:storage', IMPORT],
      });
      dbMock.dbRead.appUserScopeGrant.findUnique.mockResolvedValue({
        grantedScopes: granted,
        revokedAt: null,
      });
    };

    it('🔴 is carried when the viewer granted it, as every consent-gated scope is', async () => {
      importingApp([SCOPE, IMPORT]);
      const { res, claims } = await drive('civ_oauth_import');
      expect(res.statusCode).toBe(200);
      expect([...(claims?.scopes ?? [])].sort()).toEqual(['apps:storage', IMPORT, SCOPE]);
    });

    it('is withheld when the viewer did not grant it: the scope ledger still binds', async () => {
      importingApp([SCOPE]);
      const { claims } = await drive('civ_oauth_import');
      expect([...(claims?.scopes ?? [])].sort()).toEqual(['apps:storage', SCOPE]);
    });
  });

  /**
   * 🔴 SEAM: the claims the REAL hub path builds (`withBlockScope` → `resolveHubTokenClaims`), fed
   * into the REAL storage resolvers (`resolveStorageAccess` → `resolveImportAccess` → the
   * collection-read predicate). The ledger row is what an INSTALL records
   * (`BlockRegistry.recordInstallConsent`: every consent-gated scope of the approved manifest, no
   * prompt), so the hub token carries `apps:storage:import` without the viewer ever being shown a
   * source. For a hub token, nothing withholds it (the block mint's `withholdUncoveredImportScope`
   * does not run here): the per-source grant is the ONLY consent check, and these cases pin it.
   */
  describe('seam: real hub claims into the real import resolver', () => {
    const IMPORT = 'apps:storage:import';
    const SOURCE_ID = 'apb_src_5521';
    const SOURCE_BLOCK = 'journal-src-5521';
    // `user:read:self` is the scope the driven route requires.
    const consumerManifest = {
      scopes: [SCOPE, 'apps:storage', IMPORT],
      storage: {
        collections: { scratch: { visibility: 'private' } },
        imports: [{ from: SOURCE_BLOCK, collections: ['entries'], access: 'read' }],
      },
    };
    const sourceManifest = {
      contentRating: 'pg',
      scopes: ['apps:storage'],
      storage: { collections: { entries: { visibility: 'private' } } },
    };
    /** The per-source grant rows (`app_storage_import_grants`), read on the primary. */
    let perSourceGrant: { collections: string[]; access: 'read' | 'readwrite' } | null;
    let grantReads: unknown[][];

    beforeEach(async () => {
      perSourceGrant = null;
      grantReads = [];
      sessionMock.mockResolvedValue({
        user: { id: USER_ID },
        apiKeyId: 58,
        subject: { type: 'oauth', id: CLIENT_ID },
      });
      dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
        id: APP_BLOCK_ID,
        blockId: BLOCK_ID,
        manifest: consumerManifest,
        approvedScopes: [SCOPE, 'apps:storage', IMPORT],
      });
      // What an install writes: the consent-gated subset of the effective scopes, via the same
      // helpers `recordInstallConsent` calls.
      const { effectiveBlockScopes } = await import('~/shared/constants/block-effective-scopes');
      const { consentGatedScopes } = await import('~/server/services/blocks/scope-grant.service');
      const installed = consentGatedScopes(
        effectiveBlockScopes(consumerManifest, [SCOPE, 'apps:storage', IMPORT])
      );
      expect(installed).toContain(IMPORT);
      dbMock.dbRead.appUserScopeGrant.findUnique.mockResolvedValue({
        grantedScopes: installed,
        revokedAt: null,
        revokedScopes: [],
      });
      // The strict approval of the consumer, and the source's row for the predicate.
      dbMock.dbRead.appBlock.findUnique.mockImplementation(
        async ({
          where,
        }: {
          where: { blockId?: string; id?: string; appId_blockId?: { appId: string } };
        }) => {
          if (where.appId_blockId) {
            return where.appId_blockId.appId === CLIENT_ID
              ? { id: APP_BLOCK_ID, status: 'approved', manifest: consumerManifest }
              : null;
          }
          if (where.blockId === SOURCE_BLOCK) {
            return {
              id: SOURCE_ID,
              appId: 'app_src_5521',
              status: 'approved',
              manifest: sourceManifest,
              updatedAt: null,
            };
          }
          if (where.id === APP_BLOCK_ID) return { manifest: consumerManifest, updatedAt: null };
          return { status: 'approved' };
        }
      );
      dbMock.dbWrite.$queryRaw.mockImplementation(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (!strings.join('?').includes('app_storage_import_grants')) return [];
          grantReads.push(values);
          return perSourceGrant ? [{ sourceAppBlockId: SOURCE_ID, ...perSourceGrant }] : [];
        }
      );
      // The run gate on the viewer: they may run apps.
      isFliptMock.mockImplementation(async () => true);
      const { sessionClient } = await import('~/server/auth/session-client');
      vi.spyOn(sessionClient, 'getSessionUserById').mockResolvedValue({
        id: USER_ID,
        isModerator: false,
        tier: 'free',
        onboarding: 0,
      } as never);
    });

    afterEach(() => {
      // Back to the file's defaults, so no later case inherits the open run gate or the spy.
      isFliptMock.mockImplementation(async (flag: string) => flag === 'app-blocks-runtime-enabled');
      vi.restoreAllMocks();
    });

    async function importThroughRealHubClaims() {
      const { claims } = await drive('civ_oauth_seam');
      expect(claims).toBeDefined();
      // The install-recorded ledger scope rides on the real hub claims, with no source shown.
      expect(claims!.scopes).toContain(IMPORT);
      const { resolveStorageAccess, resolveImportAccess } = await import(
        '~/server/services/apps/doc-store-access'
      );
      const own = await resolveStorageAccess(claims!, { consentUnavailable: false });
      expect(own.tokenKind).toBe('hub');
      return resolveImportAccess(own, { from: SOURCE_BLOCK, collection: 'entries', op: 'read' });
    }

    it('🔴 an install-recorded ledger scope with NO per-source grant is refused consent_required', async () => {
      await expect(importThroughRealHubClaims()).rejects.toMatchObject({
        code: 'consent_required',
        details: { scope: IMPORT, from: SOURCE_BLOCK },
      });
      // The refusal came from the per-source grant read, for this viewer, consumer and source.
      expect(grantReads).toEqual([[USER_ID, APP_BLOCK_ID, SOURCE_ID]]);
    });

    it('POSITIVE CONTROL: with the per-source grant covering the import, it is allowed', async () => {
      perSourceGrant = { collections: ['entries'], access: 'read' };
      await expect(importThroughRealHubClaims()).resolves.toMatchObject({
        ctx: { appId: SOURCE_ID, ns: 'prod', viewerUid: USER_ID },
        tokenKind: 'hub',
        importedFrom: SOURCE_BLOCK,
        importer: BLOCK_ID,
      });
    });
  });

  it('does not even look at an opaque bearer while the flag is off', async () => {
    setEnv({ APP_BLOCK_OAUTH_TOKENS_ENABLED: false });

    const { handler, claims } = await drive('civ_oauth_token');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(claims).toBeUndefined();
    expect(sessionMock).not.toHaveBeenCalled();
  });

  it('never elevates a personal API key to block claims', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 5,
      subject: { type: 'apiKey', id: 5 },
    });

    const { handler, claims } = await drive('civ_personal_key');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(claims).toBeUndefined();
    expect(dbMock.dbRead.appBlock.findFirst).not.toHaveBeenCalled();
  });

  it('binds the borrowed dev client of a never-submitted app to its author’s live tunnel', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 7,
      subject: { type: 'oauth', id: `appdev-${USER_ID}-my-app` },
    });
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);
    tunnelMock.mockResolvedValue({
      grantedScopes: ['ai:write:budgeted', SCOPE, 'collections:read:self'],
    });
    dbMock.dbRead.oauthConsent.findUnique.mockResolvedValue({ scope: TokenScope.UserRead });

    const { res, claims } = await drive('civ_dev_oauth');

    expect(res.statusCode).toBe(200);
    expect(claims).toMatchObject({
      sub: `user:${USER_ID}`,
      appId: `appdev-${USER_ID}-my-app`,
      appBlockId: 'ephemeral-my-app',
      blockId: 'my-app',
      blockInstanceId: 'page_ephemeral-my-app',
      dev: true,
      // 🔴 A dev tunnel reads at the forced-SFW ceiling; without the viewer claim it reads PG.
      maxBrowsingLevel: FORCED_SFW_CEILING,
      viewerBrowsingLevel: FORCED_SFW_CEILING,
    });
    expect([...(claims?.scopes ?? [])].sort()).toEqual(['collections:read:self', SCOPE]);
    expect(tunnelMock).toHaveBeenCalledWith(USER_ID, 'my-app');
  });

  it('🔴 narrows a dev tunnel token by its author’s own level: a PG-only author reads PG', async () => {
    userOwnLevelMock.mockResolvedValueOnce(1);
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 7,
      subject: { type: 'oauth', id: `appdev-${USER_ID}-my-app` },
    });
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);
    tunnelMock.mockResolvedValue({ grantedScopes: [SCOPE] });
    dbMock.dbRead.oauthConsent.findUnique.mockResolvedValue({ scope: TokenScope.UserRead });

    const { claims } = await drive('civ_dev_oauth');

    expect(userOwnLevelMock).toHaveBeenCalledWith(USER_ID);
    expect(claims).toMatchObject({ maxBrowsingLevel: FORCED_SFW_CEILING, viewerBrowsingLevel: 1 });
  });

  it('🔴 refuses a suspended app’s token with 401 instead of passing it on as a sign-in', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 99,
      subject: { type: 'oauth', id: CLIENT_ID },
    });
    // No approved block for the client, but the client is an app's (its block is suspended),
    // and its owner has no live tunnel.
    tunnelMock.mockResolvedValue(null);
    dbMock.dbRead.appBlock.findFirst.mockImplementation(
      async (args: { where: { status?: unknown } }) =>
        args.where.status === 'suspended' ? { id: APP_BLOCK_ID } : null
    );

    const { handler, res } = await drive('civ_oauth_access_token');

    expect(res.statusCode).toBe(401);
    expect(handler).not.toHaveBeenCalled();
    const lifecycleQuery = dbMock.dbRead.appBlock.findFirst.mock.calls.at(-1)?.[0];
    expect(lifecycleQuery.where).toEqual({ appId: CLIENT_ID, status: 'suspended' });
  });

  it('passes on the token of a client whose block is pending, not suspended', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 99,
      subject: { type: 'oauth', id: CLIENT_ID },
    });
    tunnelMock.mockResolvedValue(null);
    // The client's only block is pending (or a remix row): neither approved nor suspended.
    dbMock.dbRead.appBlock.findFirst.mockImplementation(
      async (args: { where: { status?: unknown } }) =>
        args.where.status === undefined ? { id: APP_BLOCK_ID, blockId: BLOCK_ID } : null
    );

    const { handler } = await drive('civ_oauth_access_token');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('passes an ordinary OAuth app’s token on to the route’s own sign-in', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 99,
      subject: { type: 'oauth', id: 'third-party-client' },
    });
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);

    const { handler, claims } = await drive('civ_oauth_access_token');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(claims).toBeUndefined();
  });

  it('never binds a dev client to anyone but its author, nor without a live tunnel', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 7,
      subject: { type: 'oauth', id: 'appdev-99-my-app' },
    });
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue(null);
    const foreign = await drive('civ_dev_oauth');
    expect(foreign.claims).toBeUndefined();
    expect(tunnelMock).not.toHaveBeenCalled();

    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 7,
      subject: { type: 'oauth', id: `appdev-${USER_ID}-my-app` },
    });
    tunnelMock.mockResolvedValue(null);
    const closed = await drive('civ_dev_oauth');
    expect(closed.claims).toBeUndefined();
  });

  it('binds an owned, not-yet-approved app’s real client to its author’s tunnel with real ids', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 7,
      subject: { type: 'oauth', id: CLIENT_ID },
    });
    dbMock.dbRead.appBlock.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: APP_BLOCK_ID,
      blockId: BLOCK_ID,
      manifest: { page: { buzzBudgetPerGen: 75 } },
      approvedScopes: ['ai:write:budgeted', SCOPE],
    });
    tunnelMock.mockResolvedValue({ grantedScopes: [] });
    dbMock.dbRead.oauthConsent.findUnique.mockResolvedValue({
      scope: TokenScope.UserRead | TokenScope.AIServicesWrite,
    });

    const { claims } = await drive('civ_dev_oauth');

    expect(claims).toMatchObject({
      appId: CLIENT_ID,
      appBlockId: APP_BLOCK_ID,
      blockId: BLOCK_ID,
      blockInstanceId: `page_${APP_BLOCK_ID}`,
      dev: true,
      buzzBudget: 75,
      viewerBrowsingLevel: FORCED_SFW_CEILING,
    });
    expect([...(claims?.scopes ?? [])].sort()).toEqual(['ai:write:budgeted', SCOPE]);
    expect(dbMock.dbRead.appBlock.findFirst.mock.calls[1][0].where).toEqual({
      appId: CLIENT_ID,
      app: { userId: USER_ID },
    });
  });

  it.each([
    ['at the cap', { buzzBudgetPerGen: 5000 }, 5000],
    ['one over the cap', { buzzBudgetPerGen: 5001 }, 5000],
    ['far over the cap', { buzzBudgetPerGen: 6301 }, 5000],
    ['undeclared', {}, 1000],
    ['a non-integer', { buzzBudgetPerGen: 12.5 }, 1000],
    ['negative', { buzzBudgetPerGen: -5 }, 1000],
  ])(
    'an owned, not-yet-approved app’s budget, %s, resolves on its dev-tunnel hub token',
    async (_l, page, minted) => {
      sessionMock.mockResolvedValue({
        user: { id: USER_ID },
        apiKeyId: 7,
        subject: { type: 'oauth', id: CLIENT_ID },
      });
      dbMock.dbRead.appBlock.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: APP_BLOCK_ID,
        blockId: BLOCK_ID,
        manifest: { page },
        approvedScopes: ['ai:write:budgeted', SCOPE],
      });
      tunnelMock.mockResolvedValue({ grantedScopes: [] });
      dbMock.dbRead.oauthConsent.findUnique.mockResolvedValue({
        scope: TokenScope.UserRead | TokenScope.AIServicesWrite,
      });

      const { claims } = await drive('civ_dev_oauth');

      expect(claims?.dev).toBe(true);
      expect(claims?.buzzBudget).toBe(minted);
    }
  );

  it('carries an approved block’s under-cap buzzBudgetPerGen through unchanged', async () => {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId: 99,
      subject: { type: 'oauth', id: CLIENT_ID },
    });
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
      id: APP_BLOCK_ID,
      blockId: BLOCK_ID,
      manifest: { scopes: ['ai:write:budgeted', SCOPE], page: { buzzBudgetPerGen: 75 } },
      approvedScopes: ['ai:write:budgeted', SCOPE],
    });
    dbMock.dbRead.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: ['ai:write:budgeted', SCOPE],
      revokedAt: null,
    });

    const { res, claims } = await drive('civ_oauth_access_token');

    expect(res.statusCode).toBe(200);
    expect(claims?.buzzBudget).toBe(75);
  });

  // 6301 overshoots the cap without being a multiple of it. A non-integer falls back to
  // the default; a negative integer clamps to 0, which every spend gate refuses.
  it.each([
    ['at the cap', { buzzBudgetPerGen: 5000 }, 5000],
    ['one over the cap', { buzzBudgetPerGen: 5001 }, 5000],
    ['far over the cap', { buzzBudgetPerGen: 6301 }, 5000],
    ['undeclared', {}, 1000],
    ['a non-integer', { buzzBudgetPerGen: 12.5 }, 1000],
    ['a non-number', { buzzBudgetPerGen: '200' }, 1000],
    ['negative', { buzzBudgetPerGen: -5 }, 0],
  ])(
    'an approved block’s budget, %s, resolves to the hub token’s buzzBudget',
    async (_l, page, minted) => {
      sessionMock.mockResolvedValue({
        user: { id: USER_ID },
        apiKeyId: 99,
        subject: { type: 'oauth', id: CLIENT_ID },
      });
      dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
        id: APP_BLOCK_ID,
        blockId: BLOCK_ID,
        manifest: { scopes: ['ai:write:budgeted', SCOPE], page },
        approvedScopes: ['ai:write:budgeted', SCOPE],
      });
      dbMock.dbRead.appUserScopeGrant.findUnique.mockResolvedValue({
        grantedScopes: ['ai:write:budgeted', SCOPE],
        revokedAt: null,
      });

      const { res, claims } = await drive('civ_oauth_access_token');

      expect(res.statusCode).toBe(200);
      expect(claims?.scopes).toContain('ai:write:budgeted');
      expect(claims?.buzzBudget).toBe(minted);
    }
  );

  it('still accepts a block JWT on the unchanged path', async () => {
    const { token } = await BlockTokenService.sign({
      userId: USER_ID,
      blockId: BLOCK_ID,
      appId: CLIENT_ID,
      appBlockId: APP_BLOCK_ID,
      blockInstanceId: 'bki_hub',
      scopes: [SCOPE],
      ctx: {},
    } as Parameters<typeof BlockTokenService.sign>[0]);

    const { res, claims } = await drive(token);

    expect(res.statusCode).toBe(200);
    expect(claims).toMatchObject({ sub: `user:${USER_ID}`, blockInstanceId: 'bki_hub' });
    expect(sessionMock).not.toHaveBeenCalled();
  });
});

describe('hub-token block claims under bearer-scope-tighten', () => {
  const SPEND_AND_BUZZ = [SCOPE, 'apps:storage:read', 'buzz:read:self', 'ai:write:budgeted'];
  beforeEach(() => {
    fliptVariantMock.mockResolvedValue(undefined);
    dbMock.dbRead.appBlock.findFirst.mockResolvedValue({
      id: APP_BLOCK_ID,
      blockId: BLOCK_ID,
      manifest: { scopes: SPEND_AND_BUZZ, page: { buzzBudgetPerGen: 75 } },
      approvedScopes: SPEND_AND_BUZZ,
    });
    dbMock.dbRead.appUserScopeGrant.findUnique.mockResolvedValue({
      grantedScopes: [SCOPE, 'buzz:read:self', 'ai:write:budgeted'],
      revokedAt: null,
    });
  });

  function tokenWith(tokenScope: bigint, apiKeyId = 99) {
    sessionMock.mockResolvedValue({
      user: { id: USER_ID },
      apiKeyId,
      apiKeyType: 'Access',
      subject: { type: 'oauth', id: CLIENT_ID },
      tokenScope,
    });
  }

  it('enforce: drops the scopes whose bit the token lacks, and with the spend scope its budget', async () => {
    fliptVariantMock.mockResolvedValue('enforce');
    tokenWith(TokenScope.UserRead);

    const { res, claims } = await drive('civ_oauth_access_token');

    expect(res.statusCode).toBe(200);
    // apps:storage:read carries no OAuth bit, so it stays.
    expect([...(claims?.scopes ?? [])].sort()).toEqual(['apps:storage:read', SCOPE]);
    expect(claims?.buzzBudget).toBeUndefined();
  });

  it('log: keeps every scope and logs the ones the token lacks', async () => {
    fliptVariantMock.mockResolvedValue('log');
    tokenWith(TokenScope.UserRead);

    const { claims } = await drive('civ_oauth_access_token');

    expect(claims?.scopes).toContain('buzz:read:self');
    expect(claims?.buzzBudget).toBe(75);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'bearer-scope-refused',
        payload: expect.objectContaining({
          route: 'hub-token',
          scope: ['buzz:read:self', 'ai:write:budgeted'],
          clientId: CLIENT_ID,
          credentialKind: 'oauth',
        }),
      })
    );
  });

  it('enforce: a token minted from the viewer’s consent loses nothing', async () => {
    fliptVariantMock.mockResolvedValue('enforce');
    tokenWith(oauthScopeBitsFor([SCOPE, 'buzz:read:self', 'ai:write:budgeted']));

    const { claims } = await drive('civ_oauth_access_token');

    expect([...(claims?.scopes ?? [])].sort()).toEqual(
      ['ai:write:budgeted', 'apps:storage:read', 'buzz:read:self', SCOPE].sort()
    );
    expect(claims?.buzzBudget).toBe(75);
    expect(fliptVariantMock).not.toHaveBeenCalled();
  });

  it('enforce: a grant made after the mint reaches the block once the host re-mints', async () => {
    fliptVariantMock.mockResolvedValue('enforce');
    // Minted while the viewer had granted only user:read:self.
    tokenWith(oauthScopeBitsFor([SCOPE]), 99);
    const before = await drive('civ_oauth_access_token');
    expect(before.claims?.scopes).not.toContain('buzz:read:self');

    // The host's onConsentGranted re-fetches /api/v1/block-tokens, which mints from the new grant.
    tokenWith(oauthScopeBitsFor([SCOPE, 'buzz:read:self', 'ai:write:budgeted']), 100);
    const after = await drive('civ_oauth_access_token_2');
    expect(after.claims?.scopes).toContain('buzz:read:self');
    expect(after.claims?.buzzBudget).toBe(75);
  });

  it('enforce: narrows a dev tunnel token the same way, before its budget is set', async () => {
    fliptVariantMock.mockResolvedValue('enforce');
    tokenWith(TokenScope.UserRead, 7);
    dbMock.dbRead.appBlock.findFirst.mockReset();
    dbMock.dbRead.appBlock.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: APP_BLOCK_ID,
      blockId: BLOCK_ID,
      manifest: { page: { buzzBudgetPerGen: 75 } },
      approvedScopes: ['ai:write:budgeted', SCOPE],
    });
    tunnelMock.mockResolvedValue({ grantedScopes: [] });
    dbMock.dbRead.oauthConsent.findUnique.mockResolvedValue({
      scope: TokenScope.UserRead | TokenScope.AIServicesWrite,
    });

    const { claims } = await drive('civ_dev_oauth');

    expect(claims?.dev).toBe(true);
    expect(claims?.scopes).toEqual([SCOPE]);
    expect(claims?.buzzBudget).toBeUndefined();
  });

  it('log: a dev tunnel token keeps its spend scope and budget', async () => {
    fliptVariantMock.mockResolvedValue('log');
    tokenWith(TokenScope.UserRead, 7);
    dbMock.dbRead.appBlock.findFirst.mockReset();
    dbMock.dbRead.appBlock.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: APP_BLOCK_ID,
      blockId: BLOCK_ID,
      manifest: { page: { buzzBudgetPerGen: 75 } },
      approvedScopes: ['ai:write:budgeted', SCOPE],
    });
    tunnelMock.mockResolvedValue({ grantedScopes: [] });
    dbMock.dbRead.oauthConsent.findUnique.mockResolvedValue({
      scope: TokenScope.UserRead | TokenScope.AIServicesWrite,
    });

    const { claims } = await drive('civ_dev_oauth');

    expect(claims?.scopes).toContain('ai:write:budgeted');
    expect(claims?.buzzBudget).toBe(75);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'bearer-scope-refused',
        payload: expect.objectContaining({
          route: 'dev-tunnel-hub-token',
          scope: ['ai:write:budgeted'],
        }),
      })
    );
  });
});
