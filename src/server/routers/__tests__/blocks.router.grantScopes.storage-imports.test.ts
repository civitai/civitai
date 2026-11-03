import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StorageImportGrantService from '~/server/services/apps/storage-import-grant.service';

/**
 * `blocks.grantScopes` with `apps:storage:import`: the per-source grant records EXACTLY what the
 * consent modal displayed. The client sends the imports it showed; the server compares them with
 * the approved manifest's CURRENT imports and refuses a mismatch (a version approved while the
 * prompt was open), so a viewer can never be recorded as granting something they were not shown.
 *
 * The ledger write is recorded at its entry point (its SQL runs on real Postgres in
 * `storage-import-grant.sql.behavior.test.ts`); `resolveDeclaredImports` stays real.
 */

const { mockIsAppBlocksEnabled, recordImports } = vi.hoisted(() => ({
  mockIsAppBlocksEnabled: vi.fn(async () => true),
  recordImports: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/block-registry.service', () => ({
  BlockRegistry: {
    listForModel: vi.fn(),
    installOnModel: vi.fn(),
    updateSettings: vi.fn(),
    toggleEnabled: vi.fn(),
    uninstallFromModel: vi.fn(),
    listUserSubscriptions: vi.fn(),
    listAvailable: vi.fn(),
    upsertSubscription: vi.fn(),
    deleteSubscription: vi.fn(),
    upsertUserSettings: vi.fn(),
    getEffectiveCheckpoint: vi.fn(),
  },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: mockIsAppBlocksEnabled,
}));
vi.mock('~/server/middleware/block-scope.middleware', () => ({
  verifyBlockToken: vi.fn(),
  parseSubjectUserId: vi.fn(),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestration-new.service', () => ({
  buildGenerationContext: vi.fn(),
  createWorkflowStepsFromGraphInput: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(),
}));
vi.mock('~/server/services/user.service', () => ({ getUserById: vi.fn() }));
vi.mock('~/server/services/buzz.service', () => ({ getUserBuzzAccounts: vi.fn() }));
// Same cut as `blocks.router.getInstallConfig.test.ts`: `rateLimit` pulls in a chain that needs
// the generated Prisma client at import time; rate limiting is not under test here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});
vi.mock('~/server/services/apps/storage-import-grant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageImportGrantService>()),
  recordStorageImportGrants: recordImports,
}));

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.set.mockImplementation(async () => undefined);

const IMPORT = 'apps:storage:import';
const NOTES = { from: 'notes-app', collections: ['notes', 'prefs'], access: 'readwrite' as const };
const WORDS = { from: 'words-app', collections: ['words'], access: 'read' as const };
const MANIFEST = {
  name: 'Notes Fork',
  scopes: ['apps:storage', IMPORT],
  storage: { imports: [NOTES, WORDS] },
};

function consentCtx(userId = 7421) {
  return {
    acceptableOrigin: true,
    user: { id: userId, isModerator: false, onboarding: 0x1f } as never,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {
      canViewNsfw: false,
      isBlue: false,
      isGreen: false,
      isGreenSession: false,
      appBlocks: true,
    } as never,
    track: undefined,
  };
}

const grantRow = dbMock.dbWrite.appUserScopeGrant;

beforeEach(() => {
  recordImports.mockClear();
  dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
    status: 'approved',
    version: '2.0.0',
    manifest: MANIFEST,
    approvedScopes: ['apps:storage', IMPORT],
  });
  // `notes-app` is an approved app; `words-app` is not (no grant row can be written for it).
  dbMock.dbRead.appBlock.findMany.mockResolvedValue([
    { id: 'apb_src_3511', blockId: 'notes-app', manifest: { name: 'Notes App' } },
  ]);
  grantRow.findUnique.mockReset();
  grantRow.create.mockReset();
  grantRow.update.mockReset();
  grantRow.findUnique.mockResolvedValue(null);
  grantRow.create.mockResolvedValue({});
  grantRow.update.mockResolvedValue({});
});

const grant = (storageImports?: unknown) =>
  blocksRouter.createCaller(consentCtx() as never).grantScopes({
    appBlockId: 'apb_fork_3501',
    scopes: [IMPORT],
    ...(storageImports === undefined ? {} : { storageImports }),
  } as never);

describe('blocks.grantScopes records the imports the viewer was shown', () => {
  it('shown = current: one grant per approved source, with its collections and access', async () => {
    // Order and collection order are the modal's own; they do not matter.
    await grant([WORDS, { ...NOTES, collections: ['prefs', 'notes'] }]);
    expect(recordImports).toHaveBeenCalledTimes(1);
    expect(recordImports.mock.calls[0]).toEqual([
      {
        userId: 7421,
        consumerAppBlockId: 'apb_fork_3501',
        grants: [
          {
            sourceAppBlockId: 'apb_src_3511',
            collections: ['notes', 'prefs'],
            access: 'readwrite',
          },
        ],
      },
    ]);
    expect(grantRow.create).toHaveBeenCalledTimes(1);
  });

  it('records no grant for a mature-rated source on a host that cannot show mature content', async () => {
    dbMock.dbRead.appBlock.findMany.mockResolvedValue([
      {
        id: 'apb_src_3511',
        blockId: 'notes-app',
        manifest: { name: 'Notes App', contentRating: 'x' },
      },
    ]);
    // The consent context's host is empty: not red-capable.
    await grant([NOTES, WORDS]);
    expect(recordImports).toHaveBeenCalledTimes(1);
    expect(recordImports.mock.calls[0]).toEqual([
      { userId: 7421, consumerAppBlockId: 'apb_fork_3501', grants: [] },
    ]);
  });

  it.each<[string, unknown]>([
    ['a narrower access than the manifest now declares', [{ ...NOTES, access: 'read' }, WORDS]],
    [
      'fewer collections than the manifest now declares',
      [{ ...NOTES, collections: ['notes'] }, WORDS],
    ],
    ['a source the manifest no longer declares', [NOTES, WORDS, { ...WORDS, from: 'gone-app' }]],
    ['a source missing', [NOTES]],
  ])('refuses %s, and writes nothing', async (_label, shown) => {
    await expect(grant(shown)).rejects.toMatchObject({
      code: 'CONFLICT',
      message:
        'What this app can reach in other apps changed while the prompt was open. Close it and try again.',
    });
    expect(recordImports).not.toHaveBeenCalled();
    expect(grantRow.create).not.toHaveBeenCalled();
    expect(grantRow.update).not.toHaveBeenCalled();
  });

  it('refuses the import scope without the shown imports, and writes nothing', async () => {
    await expect(grant()).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'storageImports is required to grant apps:storage:import',
    });
    expect(recordImports).not.toHaveBeenCalled();
    expect(grantRow.create).not.toHaveBeenCalled();
  });
});
