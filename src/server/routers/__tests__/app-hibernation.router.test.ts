import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppBlocksFlag from '~/server/services/app-blocks-flag';
import type * as HibernationDepsModule from '~/server/services/app-hibernation/hibernation-deps';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  sha,
  world,
  type World,
} from '~/server/services/app-hibernation/__tests__/hibernation.fakes';

/**
 * `appHibernation.*` — the viewer's own sleeping apps — through the REAL router and service.
 * Replaced at the boundary only: the flag, the wiring of the service's dependencies (in-memory
 * fakes), and the rate limiter.
 */

const h = vi.hoisted(() => ({ enabled: true, depsBuilt: 0, world: undefined as unknown as World }));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof AppBlocksFlag>()),
  isAppHibernateEnabled: vi.fn(async () => h.enabled),
}));
vi.mock('~/server/services/app-hibernation/hibernation-deps', async (importOriginal) => ({
  ...(await importOriginal<typeof HibernationDepsModule>()),
  defaultHibernationDeps: async () => {
    h.depsBuilt++;
    return h.world.deps;
  },
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(async ({ next }) => next()) };
});
vi.mock('~/server/utils/server-domain', () => ({
  isHostForColor: () => false,
  isRedCapableHost: () => false,
}));

const { appHibernationRouter } = await import('~/server/routers/app-hibernation.router');
const { beginHibernation, commitHibernation } = await import(
  '~/server/services/app-hibernation/app-hibernation.service'
);

const OWNER = 8601;
const STRANGER = 8702;
const APP = 'recipe-box';
const ARCHIVE = Buffer.from('PK\x03\x04 recipe box');

function trpcCtx(id: number) {
  return {
    acceptableOrigin: true,
    user: { id, isModerator: false, tier: 'free', username: `u${id}`, onboarding: 0x1f },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}
const caller = (id: number) => appHibernationRouter.createCaller(trpcCtx(id) as never);

beforeEach(async () => {
  h.enabled = true;
  h.depsBuilt = 0;
  h.world = world();
  const attemptId = '77777777-7777-4777-8777-777777777777';
  const b = await beginHibernation({ userId: OWNER, app: APP, attemptId }, h.world.deps);
  if (b.kind !== 'ok') throw new Error(b.kind);
  h.world.objects.set(b.archive.key, ARCHIVE);
  await commitHibernation(
    { attemptId, sha256: sha(ARCHIVE), bytes: ARCHIVE.length, excluded: [] },
    h.world.deps
  );
});

describe('appHibernation router', () => {
  it('with the flag off every procedure is FORBIDDEN and reaches no service', async () => {
    h.enabled = false;
    const c = caller(OWNER);
    await expect(c.listMine()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.getWakeSeed({ app: APP })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.deleteMine({ app: APP })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.deleteOldestAndContinue({ app: APP })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(h.depsBuilt).toBe(0);
    expect(h.world.ticketsMap.size).toBe(0);
    expect(h.world.rows.size).toBe(1);
  });

  it('lists and wakes the viewer’s own app; a stranger sees none and cannot wake it', async () => {
    expect(await caller(OWNER).listMine()).toMatchObject([{ app: APP, bytes: ARCHIVE.length }]);
    const seed = await caller(OWNER).getWakeSeed({ app: APP });
    expect(seed).toMatchObject({ app: APP, sha256: sha(ARCHIVE), bytes: ARCHIVE.length });
    // One ticket, minted for the caller's own user, app and archive.
    expect([...h.world.ticketsMap.values()]).toEqual([
      { userId: OWNER, app: APP, sha256: sha(ARCHIVE) },
    ]);
    expect(seed.ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(await caller(STRANGER).listMine()).toEqual([]);
    await expect(caller(STRANGER).getWakeSeed({ app: APP })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(h.world.ticketsMap.size).toBe(1);
  });

  it('delete removes the row and its objects; a stranger cannot delete it', async () => {
    await expect(caller(STRANGER).deleteMine({ app: APP })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(h.world.rows.size).toBe(1);

    expect(await caller(OWNER).deleteMine({ app: APP })).toEqual({ deleted: APP });
    expect(h.world.rows.size).toBe(0);
    expect([...h.world.objects.keys()].filter((k) => k.endsWith('.zip'))).toEqual([]);
    await expect(caller(OWNER).deleteMine({ app: APP })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('deleteOldestAndContinue deletes only the app the user confirmed, recorded as at the limit', async () => {
    await expect(caller(STRANGER).deleteOldestAndContinue({ app: APP })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await caller(OWNER).deleteOldestAndContinue({ app: APP })).toEqual({ deleted: APP });
    expect(h.world.rows.size).toBe(0);
    expect(h.world.reports.at(-1)).toMatchObject({
      event: 'app-hibernation.deleted',
      details: { userId: OWNER, app: APP, why: 'limit' },
    });
  });

  it('refuses a key that is not an app slug before any service runs', async () => {
    await expect(caller(OWNER).getWakeSeed({ app: '../etc' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(h.world.ticketsMap.size).toBe(0);
  });
});
