import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { listMyScopeInvocations } from '~/server/services/blocks/user-app-surface.service';

/**
 * REGRESSION: a pre-approval dev app's calls (`ephemeral-<slug>`) are written with
 * `appBlockId: null` and the app in `syntheticAppId`, so a per-app read filtered on `appBlockId`
 * never finds them — App Assistant's activity read for an unpublished app showed no calls at all.
 * `listMyScopeInvocations({ syntheticAppId })` reads exactly that app's rows, for that user only.
 */

// The canonical db mock (registered in src/__tests__/setup.ts).
const findMany = dbMock.dbRead.blockScopeInvocation.findMany;

const whereOf = () => findMany.mock.calls[0]![0].where;

describe('listMyScopeInvocations — one pre-approval dev app', () => {
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  it('filters on the synthetic app id, for the caller only', async () => {
    await listMyScopeInvocations({ userId: 42, syntheticAppId: 'ephemeral-slideshow' });
    expect(whereOf()).toEqual({ userId: 42, syntheticAppId: 'ephemeral-slideshow' });
  });

  it('a real app id still wins, as before', async () => {
    await listMyScopeInvocations({
      userId: 42,
      appBlockId: 'apb_01J0REAL',
      syntheticAppId: 'ephemeral-slideshow',
    });
    expect(whereOf()).toEqual({ userId: 42, appBlockId: 'apb_01J0REAL' });
  });

  it('with neither, it is still the whole-account feed (both populations, no external OAuth)', async () => {
    await listMyScopeInvocations({ userId: 42 });
    expect(whereOf()).toEqual({
      userId: 42,
      OR: [{ appBlockId: { not: null } }, { syntheticAppId: { not: null } }],
    });
  });

  it('returns a synthetic row with no app id', async () => {
    findMany.mockResolvedValueOnce([
      {
        id: 7n,
        invokedAt: new Date('2026-10-30T11:59:00Z'),
        appBlockId: null,
        blockInstanceId: 'page_ephemeral-slideshow',
        scope: 'ai:write:budgeted',
        endpoint: '/api/v1/blocks/workflows/submit',
        statusCode: 200,
        detail: null,
        appBlock: null,
      },
    ]);
    const { items } = await listMyScopeInvocations({
      userId: 42,
      syntheticAppId: 'ephemeral-slideshow',
    });
    expect(items).toMatchObject([
      { id: '7', endpoint: '/api/v1/blocks/workflows/submit', statusCode: 200, appSlug: null },
    ]);
  });
});
