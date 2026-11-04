import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as StorageImportGrantService from '~/server/services/apps/storage-import-grant.service';

/**
 * `blocks.grantScopes` with `from`: the viewer grants `apps:storage:publish` to the SOURCE app a
 * consumer imports from, so the consumer's creates, puts, counters and marks in the source's
 * shared collections can land. The consumer's block chooses `from`, so the grant is recorded only
 * for a source the consumer's APPROVED manifest imports with `readwrite`, that this host may show,
 * and whose own approved manifest asks for the scope — never for any other app, and never any other
 * scope.
 *
 * It is also refused when the grant could never be used: a consumer without `apps:storage:import`
 * in its approved ceiling cannot reach the source at all, and a source none of whose imported
 * collections is exportable AND shared has nothing a publish grant gates. The viewer's import grant
 * is NOT required: the block may ask for publish before it asks for the import.
 *
 * The consumer's own manifest asks for `apps:storage:publish` too, on purpose: a call that dropped
 * `from` and granted the consumer instead would write a grant row, and every refusal below asserts
 * that nothing is written.
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
// Same cut as `blocks.router.grantScopes.storage-imports.test.ts`: `rateLimit` pulls in a chain
// that needs the generated Prisma client at import time; rate limiting is not under test here.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});
vi.mock('~/server/services/apps/storage-import-grant.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageImportGrantService>()),
  recordStorageImportGrants: recordImports,
}));

import { blocksRouter } from '../blocks.router';
import { ConsentRevocation } from '~/server/services/blocks/consent-revocation.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
redisMock.redis.set.mockImplementation(async () => undefined);

const STORAGE = 'apps:storage';
const IMPORT = 'apps:storage:import';
const PUBLISH = 'apps:storage:publish';
const UID = 7421;
const CONSUMER_ID = 'apb_fork_3601';

type Row = {
  id: string;
  blockId: string;
  status: string;
  version: string;
  manifest: Record<string, unknown>;
  approvedScopes: string[];
};
const source = (
  id: string,
  blockId: string,
  over: Partial<Row> & { manifest?: Record<string, unknown> } = {}
): Row => ({
  id,
  blockId,
  status: 'approved',
  version: '1.4.0',
  approvedScopes: [STORAGE, PUBLISH],
  ...over,
  manifest: {
    name: `${blockId} name`,
    scopes: [STORAGE, PUBLISH],
    // The collection every `rw()` import names: shared, viewer-authored and exportable, so a
    // publish grant in the source gates the consumer's writes to it.
    storage: { collections: { board: { visibility: 'shared', write: 'own' } } },
    ...over.manifest,
  },
});
const collections = (c: Record<string, unknown>) => ({ storage: { collections: c } });

const SOURCES: Row[] = [
  source('apb_src_3611', 'notes-app', { manifest: { name: 'Notes App' } }),
  // Imported read-only.
  source('apb_src_3612', 'words-app'),
  // Approved and asks for publish, but the consumer does not import it.
  source('apb_src_3613', 'other-app'),
  // Imported readwrite; its own manifest does not ask for publish.
  source('apb_src_3614', 'quiet-app', { manifest: { scopes: [STORAGE] } }),
  // Imported readwrite; asks for publish, but the scope was not approved.
  source('apb_src_3615', 'unvetted-app', { approvedScopes: [STORAGE] }),
  // Imported readwrite; not approved.
  source('apb_src_3616', 'pending-app', { status: 'pending' }),
  // Imported readwrite; mature-rated, and the test host shows no mature content.
  source('apb_src_3617', 'mature-app', { manifest: { contentRating: 'x' } }),
  // Imported readwrite; its `board` is private, so no write there needs publish.
  source('apb_src_3618', 'private-app', {
    manifest: collections({ board: { visibility: 'private' } }),
  }),
  // Imported readwrite; its `board` is shared but not exportable, so the import reaches nothing.
  source('apb_src_3619', 'closed-app', {
    manifest: collections({ board: { visibility: 'shared', write: 'own', exportable: false } }),
  }),
  // Imported readwrite; it declares no `board` at all.
  source('apb_src_3620', 'renamed-app', {
    manifest: collections({ posts: { visibility: 'shared', write: 'own' } }),
  }),
  // Imported readwrite with two collections: `notes` is private, `board` is shared.
  source('apb_src_3621', 'mixed-app', {
    manifest: collections({
      notes: { visibility: 'private' },
      board: { visibility: 'shared', write: 'own' },
    }),
  }),
];

const rw = (from: string) => ({ from, collections: ['board'], access: 'readwrite' as const });
const CONSUMER: Row = {
  id: CONSUMER_ID,
  blockId: 'notes-fork',
  status: 'approved',
  version: '2.0.0',
  manifest: {
    name: 'Notes Fork',
    scopes: [STORAGE, IMPORT, PUBLISH],
    storage: {
      collections: { mine: { visibility: 'shared', write: 'own' } },
      imports: [
        rw('notes-app'),
        { from: 'words-app', collections: ['words'], access: 'read' },
        rw('quiet-app'),
        rw('unvetted-app'),
        rw('pending-app'),
        rw('mature-app'),
      ],
    },
  },
  approvedScopes: [STORAGE, IMPORT, PUBLISH],
};
/** The consumer row the db mocks serve; a test may replace it (reset in `beforeEach`). */
let consumer: Row = CONSUMER;
const rows = () => [consumer, ...SOURCES];
/** The consumer with `imports` in place of its own (a manifest declares at most 8). */
const importing = (imports: unknown[], over: Partial<Row> = {}): Row => ({
  ...CONSUMER,
  ...over,
  manifest: {
    ...CONSUMER.manifest,
    storage: { collections: { mine: { visibility: 'shared', write: 'own' } }, imports },
  },
});

function consentCtx() {
  return {
    acceptableOrigin: true,
    user: { id: UID, isModerator: false, onboarding: 0x1f } as never,
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    // Not a red-capable host: a mature-rated source is not shown here.
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
  consumer = CONSUMER;
  dbMock.dbRead.appBlock.findUnique.mockImplementation(
    (async ({ where }: { where: { id?: string; blockId?: string } }) =>
      rows().find((r) =>
        where.id !== undefined ? r.id === where.id : r.blockId === where.blockId
      ) ?? null) as never
  );
  dbMock.dbRead.appBlock.findMany.mockImplementation((async ({
    where,
  }: {
    where: { blockId?: { in: string[] }; status?: string };
  }) =>
    rows().filter(
      (r) =>
        (where.blockId?.in ?? []).includes(r.blockId) &&
        (where.status === undefined || r.status === where.status)
    )) as never);
  grantRow.findUnique.mockReset();
  grantRow.create.mockReset();
  grantRow.update.mockReset();
  grantRow.findUnique.mockResolvedValue(null);
  grantRow.create.mockResolvedValue({});
  grantRow.update.mockResolvedValue({});
});

const grant = (input: Record<string, unknown>) =>
  blocksRouter
    .createCaller(consentCtx() as never)
    .grantScopes({ appBlockId: CONSUMER_ID, scopes: [PUBLISH], ...input } as never);

const nothingWritten = () => {
  expect(grantRow.create).not.toHaveBeenCalled();
  expect(grantRow.update).not.toHaveBeenCalled();
  expect(recordImports).not.toHaveBeenCalled();
};

describe('blocks.grantScopes with from: publish consent in the source app', () => {
  it("records apps:storage:publish in the SOURCE app's grant, not the consumer's", async () => {
    const res = await grant({ from: 'notes-app' });
    expect(res).toMatchObject({ ok: true, granted: [PUBLISH] });
    expect(grantRow.create).toHaveBeenCalledTimes(1);
    expect(grantRow.create.mock.calls[0][0]).toMatchObject({
      data: {
        userId: UID,
        appBlockId: 'apb_src_3611',
        version: '1.4.0',
        grantedScopes: [PUBLISH],
      },
    });
    expect(grantRow.update).not.toHaveBeenCalled();
    expect(recordImports).not.toHaveBeenCalled();
  });

  it('adds the scope to a grant the viewer already holds in the source', async () => {
    grantRow.findUnique.mockResolvedValue({
      id: 'grant_src_1',
      grantedScopes: [STORAGE],
      revokedScopes: [],
      revokedAt: null,
    } as never);
    await grant({ from: 'notes-app' });
    expect(grantRow.findUnique.mock.calls[0][0]).toMatchObject({
      where: { userId_appBlockId: { userId: UID, appBlockId: 'apb_src_3611' } },
    });
    expect(grantRow.update).toHaveBeenCalledTimes(1);
    expect(grantRow.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'grant_src_1' },
      data: { grantedScopes: [STORAGE, PUBLISH], version: '1.4.0' },
    });
    expect(grantRow.create).not.toHaveBeenCalled();
  });

  it.each<[string, string, string, string]>([
    [
      'a source the consumer imports read-only',
      'words-app',
      'FORBIDDEN',
      'This app does not change your data in words-app, so it cannot ask for this permission there.',
    ],
    [
      'a source the consumer does not import',
      'other-app',
      'FORBIDDEN',
      'This app does not change your data in other-app, so it cannot ask for this permission there.',
    ],
    [
      'a source whose own manifest does not ask for publish',
      'quiet-app',
      'BAD_REQUEST',
      'quiet-app does not ask for apps:storage:publish',
    ],
    [
      'a source whose publish scope was not approved',
      'unvetted-app',
      'BAD_REQUEST',
      'unvetted-app does not ask for apps:storage:publish',
    ],
    ['a source that is not approved', 'pending-app', 'NOT_FOUND', 'pending-app is not available'],
    [
      'a mature-rated source on a host that shows no mature content',
      'mature-app',
      'FORBIDDEN',
      'mature-app is not available on this site',
    ],
  ])('refuses %s, and writes nothing', async (_label, from, code, message) => {
    await expect(grant({ from })).rejects.toMatchObject({ code, message });
    nothingWritten();
  });

  it.each<[string, Row, string, string]>([
    [
      'a consumer whose approved scopes lack apps:storage:import',
      { ...CONSUMER, approvedScopes: [STORAGE, PUBLISH] },
      'notes-app',
      'This app was not approved to reach your data in other apps, so it cannot ask for this permission there.',
    ],
    [
      'a consumer whose manifest scopes lack apps:storage:import',
      { ...CONSUMER, manifest: { ...CONSUMER.manifest, scopes: [STORAGE, PUBLISH] } },
      'notes-app',
      'This app was not approved to reach your data in other apps, so it cannot ask for this permission there.',
    ],
    [
      'a source whose imported collection is private',
      importing([rw('private-app')]),
      'private-app',
      'This app adds nothing public in private-app, so it does not need this permission there.',
    ],
    [
      'a source whose imported collection is not exportable',
      importing([rw('closed-app')]),
      'closed-app',
      'This app adds nothing public in closed-app, so it does not need this permission there.',
    ],
    [
      'a source that does not declare the imported collection',
      importing([rw('renamed-app')]),
      'renamed-app',
      'This app adds nothing public in renamed-app, so it does not need this permission there.',
    ],
    [
      'a source whose shared collection the consumer does not import (only its private one)',
      importing([{ from: 'mixed-app', collections: ['notes'], access: 'readwrite' }]),
      'mixed-app',
      'This app adds nothing public in mixed-app, so it does not need this permission there.',
    ],
  ])('refuses %s with FORBIDDEN, and writes nothing', async (_label, row, from, message) => {
    consumer = row;
    await expect(grant({ from })).rejects.toMatchObject({ code: 'FORBIDDEN', message });
    nothingWritten();
  });

  // INVARIANT GUARD (passes before the refusals above existed): "at least one", not "every".
  it('INVARIANT GUARD: grants when one imported collection is shared and exportable in the source', async () => {
    consumer = importing([
      { from: 'mixed-app', collections: ['notes', 'board'], access: 'readwrite' },
    ]);
    await expect(grant({ from: 'mixed-app' })).resolves.toMatchObject({ granted: [PUBLISH] });
    expect(grantRow.create).toHaveBeenCalledTimes(1);
    expect(grantRow.create.mock.calls[0][0]).toMatchObject({
      data: { userId: UID, appBlockId: 'apb_src_3621', grantedScopes: [PUBLISH] },
    });
  });

  // INVARIANT GUARD (it passes on the code before this test was added): the self-import branch.
  // The submit-time validator already refuses an import from the app's own blockId; this pins the
  // grant's own refusal for a stored manifest that has one. The consumer's `mine` is shared and
  // exportable and its ceiling holds publish, so without the branch a row WOULD be written.
  it('INVARIANT GUARD: refuses an import whose from is the consumer itself, and writes nothing', async () => {
    consumer = importing([{ from: 'notes-fork', collections: ['mine'], access: 'readwrite' }]);
    await expect(grant({ from: 'notes-fork' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'notes-fork is not available',
    });
    nothingWritten();
  });

  // GUARD on which app the follow-ups run for: a re-consent that lifts a per-scope revoke must
  // re-publish the SOURCE's suppression marker (the grant row it changed), never the consumer's.
  it("after a per-scope revoke of publish in the source, re-publishes the SOURCE's revocation marker", async () => {
    const SPEND = 'ai:write:budgeted';
    grantRow.findUnique.mockResolvedValue({
      id: 'grant_src_2',
      grantedScopes: [STORAGE],
      revokedScopes: [PUBLISH, SPEND],
      revokedAt: null,
    } as never);
    const publish = vi.spyOn(ConsentRevocation, 'publish').mockResolvedValue(undefined);
    try {
      await grant({ from: 'notes-app' });
      expect(grantRow.update.mock.calls[0][0]).toMatchObject({
        where: { id: 'grant_src_2' },
        data: { revokedScopes: [SPEND] },
      });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0][0]).toEqual({
        userId: UID,
        appBlockId: 'apb_src_3611',
        revokedScopes: [SPEND],
      });
    } finally {
      publish.mockRestore();
    }
  });

  it.each<[string, Record<string, unknown>]>([
    ['another scope alongside publish', { scopes: [PUBLISH, IMPORT] }],
    ['a scope other than publish', { scopes: [STORAGE] }],
    ['a Buzz budget', { buzzBudgetPerDay: 100 }],
    ['shown imports', { storageImports: [rw('notes-app')] }],
  ])('refuses %s with from, and writes nothing', async (_label, extra) => {
    await expect(grant({ from: 'notes-app', ...extra })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'With from, the only scope that can be granted is apps:storage:publish',
    });
    nothingWritten();
  });

  it('INVARIANT GUARD: refuses a consumer that is not approved, and writes nothing', async () => {
    const pending = { ...CONSUMER, status: 'pending' };
    dbMock.dbRead.appBlock.findUnique.mockImplementation((async ({
      where,
    }: {
      where: { id?: string; blockId?: string };
    }) =>
      where.id === CONSUMER_ID
        ? pending
        : rows().find((r) => r.blockId === where.blockId) ?? null) as never);
    await expect(grant({ from: 'notes-app' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'App block is not approved',
    });
    nothingWritten();
  });

  it('INVARIANT GUARD: without from, publish is still granted to the app itself', async () => {
    await grant({});
    expect(grantRow.create).toHaveBeenCalledTimes(1);
    expect(grantRow.create.mock.calls[0][0]).toMatchObject({
      data: { userId: UID, appBlockId: CONSUMER_ID, grantedScopes: [PUBLISH] },
    });
  });
});
