import { describe, expect, it } from 'vitest';
import {
  beginHibernation,
  commitHibernation,
  restoreSleepingAppSecrets,
} from '~/server/services/app-hibernation/app-hibernation.service';
import {
  deleteSleepingApp,
  getWakeSeed,
  listSleepingApps,
} from '~/server/services/app-hibernation/sleeping-apps.service';
import {
  NOW,
  sha,
  world,
  type World,
} from '~/server/services/app-hibernation/__tests__/hibernation.fakes';

/**
 * The signed-in user's own sleeping apps: list, wake seed (with its one-time ticket), delete. Run
 * against the real begin/commit, so every record here is one the sandbox service could have made.
 */

const OWNER = 7311;
const STRANGER = 7422;
const APP = 'recipe-box';
const OTHER_APP = 'tide-chart';
const ARCHIVE = Buffer.from('PK\x03\x04 recipe box archive');
const OTHER_ARCHIVE = Buffer.from('PK\x03\x04 tide chart archive, longer');

async function sleepApp(
  w: World,
  userId: number,
  app: string,
  archive: Buffer,
  attemptId: string,
  secrets?: string
) {
  const b = await beginHibernation({ userId, app, attemptId }, w.deps);
  if (b.kind !== 'ok') throw new Error(b.kind);
  w.objects.set(b.archive.key, archive);
  const c = await commitHibernation(
    {
      attemptId,
      sha256: sha(archive),
      bytes: archive.length,
      excluded: ['node_modules'],
      lastActivityAt: '2026-11-01T08:00:00.000Z',
      ...(secrets ? { secretsBlob: Buffer.from(secrets).toString('base64') } : {}),
    },
    w.deps
  );
  if (c.kind !== 'committed') throw new Error(c.kind);
}

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';

describe('listSleepingApps', () => {
  it('lists only the user’s own apps, with no object key, hash or key material', async () => {
    const w = world();
    await sleepApp(w, OWNER, APP, ARCHIVE, A1, 'TOKEN=x');
    await sleepApp(w, STRANGER, OTHER_APP, OTHER_ARCHIVE, A2);
    const mine = await listSleepingApps(OWNER, w.deps);
    expect(mine).toEqual([
      {
        app: APP,
        sha256: sha(ARCHIVE),
        bytes: ARCHIVE.length,
        appCreatedAt: null,
        lastActivityAt: '2026-11-01T08:00:00.000Z',
        hibernatedAt: NOW.toISOString(),
      },
    ]);
    expect(await listSleepingApps(STRANGER, w.deps)).toMatchObject([{ app: OTHER_APP }]);
  });
});

describe('getWakeSeed', () => {
  it('answers a GET of the recorded archive and a ticket that releases THIS record’s secrets once', async () => {
    const w = world();
    await sleepApp(w, OWNER, APP, ARCHIVE, A1, 'TOKEN=abc');
    const r = await getWakeSeed(OWNER, APP, w.deps);
    if (r.kind !== 'ok') throw new Error(r.kind);
    const row = w.rows.get(`${OWNER}/${APP}`)!;
    expect(r.seed).toMatchObject({
      app: APP,
      url: `https://store.test/get/${row.objectKey}`,
      sha256: sha(ARCHIVE),
      bytes: ARCHIVE.length,
    });
    // The ticket the seed carries is the one the sandbox service redeems for the secrets.
    const restored = await restoreSleepingAppSecrets(
      { userId: OWNER, app: APP, sha256: r.seed.sha256, ticket: r.seed.ticket },
      w.deps
    );
    expect(restored).toEqual({ kind: 'ok', blob: Buffer.from('TOKEN=abc').toString('base64') });
    expect(
      await restoreSleepingAppSecrets(
        { userId: OWNER, app: APP, sha256: r.seed.sha256, ticket: r.seed.ticket },
        w.deps
      )
    ).toEqual({ kind: 'ticket' });
  });

  it('mints nothing for another user’s app, an unknown app, a closed account or the flag off', async () => {
    const w = world();
    await sleepApp(w, OWNER, APP, ARCHIVE, A1);
    expect(await getWakeSeed(STRANGER, APP, w.deps)).toEqual({ kind: 'not-found' });
    expect(await getWakeSeed(OWNER, OTHER_APP, w.deps)).toEqual({ kind: 'not-found' });
    w.accounts.set(OWNER, 'banned');
    expect(await getWakeSeed(OWNER, APP, w.deps)).toEqual({ kind: 'account-closed' });
    w.accounts.set(OWNER, 'active');
    w.state.enabled = false;
    expect(await getWakeSeed(OWNER, APP, w.deps)).toEqual({ kind: 'disabled' });
    expect(w.ticketsMap.size).toBe(0);
  });

  it('a store that cannot presign mints no ticket', async () => {
    const w = world();
    await sleepApp(w, OWNER, APP, ARCHIVE, A1);
    (w.deps.store as { canPresign: boolean }).canPresign = false;
    expect(await getWakeSeed(OWNER, APP, w.deps)).toEqual({ kind: 'not-configured' });
    expect(w.ticketsMap.size).toBe(0);
  });

  it('a commit landing between the ticket and the read is retried, so seed and ticket agree', async () => {
    const w = world();
    await sleepApp(w, OWNER, APP, ARCHIVE, A1);
    const realGet = w.deps.repo.get;
    let reads = 0;
    // The first read after the first ticket sees a newer record.
    w.deps.repo.get = async (userId, app) => {
      const row = await realGet(userId, app);
      if (row && ++reads === 2) return { ...row, sha256: 'f'.repeat(64) };
      return row;
    };
    const r = await getWakeSeed(OWNER, APP, w.deps);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.seed.sha256).toBe(sha(ARCHIVE));
    expect([...w.ticketsMap.values()].at(-1)).toMatchObject({ sha256: sha(ARCHIVE) });

    // Changing on every read: `changed`, never a seed whose ticket names another archive.
    w.deps.repo.get = async (userId, app) => {
      const row = await realGet(userId, app);
      return row && { ...row, sha256: `${++reads}`.padStart(64, '0') };
    };
    expect(await getWakeSeed(OWNER, APP, w.deps)).toEqual({ kind: 'changed' });
  });
});

describe('deleteSleepingApp', () => {
  it('deletes the row first, then the archive and secrets objects; a stranger deletes nothing', async () => {
    const w = world();
    await sleepApp(w, OWNER, APP, ARCHIVE, A1, 'TOKEN=x');
    const row = w.rows.get(`${OWNER}/${APP}`)!;
    expect(await deleteSleepingApp(STRANGER, APP, w.deps)).toEqual({ kind: 'not-found' });
    expect(w.rows.size).toBe(1);

    w.log.length = 0;
    expect(await deleteSleepingApp(OWNER, APP, w.deps)).toEqual({ kind: 'deleted', app: APP });
    expect(w.log).toEqual([
      `remove-row ${OWNER}/${APP}`,
      `delete ${row.objectKey}`,
      `delete ${row.secretsObjectKey}`,
    ]);
    expect(w.objects.has(row.objectKey)).toBe(false);
    expect(w.objects.has(row.secretsObjectKey!)).toBe(false);
    expect(w.reports.at(-1)).toMatchObject({
      event: 'app-hibernation.deleted',
      details: { app: APP, why: 'user' },
    });
  });

  it('an object delete that fails is reported, and the row stays deleted (the sweep removes the objects)', async () => {
    const w = world();
    await sleepApp(w, OWNER, APP, ARCHIVE, A1);
    w.storeState.failDeletes = true;
    expect(await deleteSleepingApp(OWNER, APP, w.deps, 'limit')).toEqual({
      kind: 'deleted',
      app: APP,
    });
    expect(w.rows.size).toBe(0);
    expect(w.reports.map((r) => r.event)).toEqual([
      'app-hibernation.deleted',
      'app-hibernation.delete-objects-failed',
    ]);
    expect(w.reports[0].details).toMatchObject({ why: 'limit' });
  });
});
