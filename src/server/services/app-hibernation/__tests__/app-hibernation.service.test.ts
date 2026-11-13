import { describe, expect, it } from 'vitest';
import {
  beginHibernation,
  commitHibernation,
  deleteSleepingAppsForAccount,
  getWakeSeed,
  listSleepingApps,
  restoreSleepingAppSecrets,
  type BeginResult,
  type CommitInput,
} from '~/server/services/app-hibernation/app-hibernation.service';
import { sealSecrets } from '~/server/services/app-hibernation/secrets-envelope';
import { sleepingAppLimits } from '~/server/services/blocks/user-app-caps.service';
import { defaultUsageLimitConfig } from '~/shared/constants/usage-limits';
import type { SessionUser } from '~/types/session';
import { sha, world, type World } from './hibernation.fakes';

/**
 * The civitai half of app hibernation, against in-memory boundaries (`hibernation.fakes.ts`).
 * The archive object is uploaded into the fake store exactly as the sandbox service would, so
 * every "verify from storage" check reads real bytes.
 */

const USER = 6101;
const OTHER_USER = 6202;
const APP = 'tip-calculator';
const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const ARCHIVE_1 = Buffer.from('PK\x03\x04 first archive of the app');
const ARCHIVE_2 = Buffer.from('PK\x03\x04 second archive, after a wake');

async function begin(w: World, attemptId: string, app = APP, userId = USER) {
  const r = await beginHibernation({ userId, app, attemptId }, w.deps);
  if (r.kind !== 'ok') throw new Error(`begin refused: ${r.kind}`);
  return r;
}

/** begin, upload the archive under the key civitai named, and build the matching commit body. */
async function uploaded(
  w: World,
  attemptId: string,
  archive: Buffer,
  extra: Partial<CommitInput> = {}
) {
  const b = await begin(w, attemptId);
  w.objects.set(b.archive.key, archive);
  const body: CommitInput = {
    attemptId,
    sha256: sha(archive),
    bytes: archive.length,
    excluded: ['node_modules'],
    sandboxSeedSha: null,
    ...extra,
  };
  return { b, body };
}

describe('commit verifies the object FROM STORAGE before writing anything', () => {
  it('a tampered object (same size, other bytes) is a 409 mismatch and NO row', async () => {
    const w = world();
    const { b, body } = await uploaded(w, A1, ARCHIVE_1);
    // Swapped after the sandbox service hashed it: same length, different content.
    w.objects.set(b.archive.key, Buffer.from(ARCHIVE_1.toString().replace('first', 'FIRST')));

    expect(await commitHibernation(body, w.deps)).toEqual({
      kind: 'mismatch',
      reason: 'archive sha256 mismatch',
    });
    expect(w.rows.size).toBe(0);
    expect(w.log.filter((l) => l.startsWith('delete'))).toEqual([]);
  });

  it('a size that does not match the claim, or a missing object, is refused the same way', async () => {
    const w = world();
    const { body } = await uploaded(w, A1, ARCHIVE_1);
    expect(await commitHibernation({ ...body, bytes: body.bytes + 1 }, w.deps)).toEqual({
      kind: 'mismatch',
      reason: 'archive size mismatch',
    });

    const w2 = world();
    await begin(w2, A1); // never uploaded
    expect(await commitHibernation(body, w2.deps)).toEqual({
      kind: 'mismatch',
      reason: 'archive object missing',
    });
    expect(w.rows.size + w2.rows.size).toBe(0);
  });

  it('a commit for an attempt civitai never began is refused', async () => {
    const w = world();
    expect(
      await commitHibernation(
        { attemptId: A1, sha256: sha(ARCHIVE_1), bytes: 5, excluded: [] },
        w.deps
      )
    ).toEqual({ kind: 'unknown-attempt' });
  });

  it('a matching object is recorded, and the receipt carries its sha256', async () => {
    const w = world();
    const { b, body } = await uploaded(w, A1, ARCHIVE_1);
    expect(await commitHibernation(body, w.deps)).toEqual({
      kind: 'committed',
      sha256: sha(ARCHIVE_1),
    });
    expect(w.rows.get(`${USER}/${APP}`)).toMatchObject({
      objectKey: b.archive.key,
      sha256: sha(ARCHIVE_1),
      bytes: ARCHIVE_1.length,
      secretsObjectKey: null,
    });
    expect(b.archive.key).toBe(`archives/${USER}/${APP}/${A1}.zip`);
  });
});

describe('upsert and lineage', () => {
  it('a retried commit of the same attempt is idempotent: one row, unchanged, nothing deleted', async () => {
    const w = world();
    const { b, body } = await uploaded(w, A1, ARCHIVE_1);
    const first = await commitHibernation(body, w.deps);
    const rowAfterFirst = { ...w.rows.get(`${USER}/${APP}`) };
    const second = await commitHibernation(body, w.deps);

    expect(second).toEqual(first);
    expect(w.rows.size).toBe(1);
    expect(w.rows.get(`${USER}/${APP}`)).toEqual(rowAfterFirst);
    expect(w.objects.has(b.archive.key)).toBe(true);
    expect(w.log.filter((l) => l.startsWith('write'))).toHaveLength(1);
  });

  it('a sandbox NOT woken from the stored record cannot overwrite it (409 lineage)', async () => {
    const w = world();
    const first = await uploaded(w, A1, ARCHIVE_1);
    await commitHibernation(first.body, w.deps);
    const second = await uploaded(w, A2, ARCHIVE_2, { sandboxSeedSha: null });

    expect(await commitHibernation(second.body, w.deps)).toEqual({ kind: 'lineage' });
    expect(w.rows.get(`${USER}/${APP}`)?.sha256).toBe(sha(ARCHIVE_1));
    // Neither archive was deleted: the stored one is still the record, the new one is an orphan.
    expect(w.objects.has(first.b.archive.key)).toBe(true);
    expect(w.objects.has(second.b.archive.key)).toBe(true);

    const wrongSeed = { ...second.body, sandboxSeedSha: sha(Buffer.from('some other seed')) };
    expect(await commitHibernation(wrongSeed, w.deps)).toEqual({ kind: 'lineage' });
  });

  it('a sandbox woken from the record replaces it, and the old objects go only AFTER the write', async () => {
    const w = world();
    const first = await uploaded(w, A1, ARCHIVE_1);
    await commitHibernation(first.body, w.deps);
    const second = await uploaded(w, A2, ARCHIVE_2, { sandboxSeedSha: sha(ARCHIVE_1) });

    expect(await commitHibernation(second.body, w.deps)).toEqual({
      kind: 'committed',
      sha256: sha(ARCHIVE_2),
    });
    expect(w.rows.get(`${USER}/${APP}`)?.objectKey).toBe(second.b.archive.key);
    expect(w.objects.has(first.b.archive.key)).toBe(false);
    const writeAt = w.log.indexOf(`write ${second.b.archive.key}`);
    const deleteAt = w.log.indexOf(`delete ${first.b.archive.key}`);
    expect(writeAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(writeAt);
  });
});

describe('per-plan sleeping-app limits', () => {
  // Literal registry defaults per tier, not read from the implementation.
  const EXPECTED: Record<string, { apps: number; bytes: number }> = {
    free: { apps: 10, bytes: 262_144_000 },
    founder: { apps: 25, bytes: 524_288_000 },
    bronze: { apps: 25, bytes: 524_288_000 },
    silver: { apps: 50, bytes: 1_073_741_824 },
    gold: { apps: 100, bytes: 2_147_483_648 },
  };
  const limitsFor = (tier: string | null) =>
    sleepingAppLimits(USER, {
      getConfig: async () => defaultUsageLimitConfig,
      getSessionUser: async () =>
        tier === null ? null : ({ id: USER, tier } as unknown as SessionUser),
    });

  it.each(Object.entries(EXPECTED))('%s resolves to its limits', async (tier, expected) => {
    expect(await limitsFor(tier)).toEqual(expected);
  });

  it('a user that cannot be read gets the strictest (free) limits', async () => {
    expect(await limitsFor(null)).toEqual(EXPECTED.free);
  });

  /** A world whose limits come from the real resolver, holding `n` sleeping apps of `each` bytes. */
  function holding(tier: string, n: number, each = 1_000) {
    const w = world({ tier });
    w.deps.limits = () => limitsFor(tier);
    for (let i = 0; i < n; i++) {
      w.rows.set(`${USER}/held-${i}`, {
        userId: USER,
        appKey: `held-${i}`,
        attemptId: A1,
        objectKey: `archives/${USER}/held-${i}/x.zip`,
        sha256: 'a'.repeat(64),
        bytes: each,
        excluded: [],
        secretsObjectKey: null,
        secretsSha256: null,
        secretsBytes: null,
        secretsWrappedKey: null,
        reason: null,
        appCreatedAt: null,
        lastActivityAt: null,
        hibernatedAt: new Date(0),
      });
    }
    return w;
  }

  it.each(Object.entries(EXPECTED))(
    '%s: begin refuses at exactly its app limit with SLEEPING_LIMIT, and allows one below',
    async (tier, { apps }) => {
      const atLimit = holding(tier, apps);
      expect(
        await beginHibernation({ userId: USER, app: APP, attemptId: A1 }, atLimit.deps)
      ).toEqual({
        kind: 'limit',
        limit: { kind: 'apps', limit: apps, used: apps },
      } satisfies BeginResult);
      expect(atLimit.attemptsMap.size).toBe(0);

      const below = holding(tier, apps - 1);
      expect(
        (await beginHibernation({ userId: USER, app: APP, attemptId: A1 }, below.deps)).kind
      ).toBe('ok');
    }
  );

  it('at the app limit, re-hibernating an app that is already sleeping is still allowed', async () => {
    const w = holding('free', 10);
    expect(
      (await beginHibernation({ userId: USER, app: 'held-3', attemptId: A2 }, w.deps)).kind
    ).toBe('ok');
  });

  it('begin refuses once the plan bytes are used up; commit refuses an archive that would pass them', async () => {
    const full = holding('free', 1, 262_144_000);
    expect(await beginHibernation({ userId: USER, app: APP, attemptId: A1 }, full.deps)).toEqual({
      kind: 'limit',
      limit: { kind: 'bytes', limit: 262_144_000, used: 262_144_000 },
    });

    const nearly = holding('free', 1, 262_144_000 - 10);
    const { body } = await uploaded(nearly, A1, Buffer.alloc(11, 1));
    expect(await commitHibernation(body, nearly.deps)).toEqual({
      kind: 'limit',
      limit: { kind: 'bytes', limit: 262_144_000, used: 262_144_000 - 10 },
    });
    expect(nearly.rows.has(`${USER}/${APP}`)).toBe(false);
  });
});

describe('the flag off refuses every endpoint', () => {
  it('begin, commit and the secrets restore all answer disabled and touch nothing', async () => {
    const w = world();
    const { body } = await uploaded(w, A1, ARCHIVE_1);
    w.state.enabled = false;
    const logBefore = w.log.length;

    expect(await beginHibernation({ userId: USER, app: APP, attemptId: A2 }, w.deps)).toEqual({
      kind: 'disabled',
    });
    expect(await commitHibernation(body, w.deps)).toEqual({ kind: 'disabled' });
    expect(
      await restoreSleepingAppSecrets({ userId: USER, app: APP, sha256: sha(ARCHIVE_1) }, w.deps)
    ).toEqual({ kind: 'disabled' });
    expect(w.rows.size).toBe(0);
    expect(w.attemptsMap.has(A2)).toBe(false);
    expect(w.log.slice(logBefore)).toEqual([]);
  });
});

describe('encrypted .env* secrets', () => {
  const ENV = Buffer.from('.env\0SECRET=test-only-value\n');

  async function withSecrets(
    w: World,
    attemptId: string,
    plain: Buffer,
    extra: Partial<CommitInput> = {}
  ) {
    const { b, body } = await uploaded(w, attemptId, ARCHIVE_1, extra);
    const sealed = sealSecrets(
      Buffer.from(b.secrets.dataKey, 'base64'),
      { userId: USER, appKey: APP, attemptId },
      plain
    );
    w.objects.set(b.secrets.key, sealed);
    return { b, body: { ...body, secrets: { sha256: sha(sealed), bytes: sealed.length } } };
  }

  it('commit stores them only wrapped, and the wake restore decrypts them for that seed only', async () => {
    const w = world();
    const { b, body } = await withSecrets(w, A1, ENV);
    expect((await commitHibernation(body, w.deps)).kind).toBe('committed');
    const row = w.rows.get(`${USER}/${APP}`);
    expect(row?.secretsObjectKey).toBe(b.secrets.key);
    expect(row?.secretsWrappedKey).not.toContain(b.secrets.dataKey);

    expect(
      await restoreSleepingAppSecrets({ userId: USER, app: APP, sha256: sha(ARCHIVE_1) }, w.deps)
    ).toEqual({ kind: 'ok', secrets: ENV.toString('base64') });
    expect(
      await restoreSleepingAppSecrets({ userId: USER, app: APP, sha256: 'b'.repeat(64) }, w.deps)
    ).toEqual({ kind: 'stale' });
  });

  it('a secrets blob that does not decrypt under the attempt key is a 409 and NO row', async () => {
    const w = world();
    const { b, body } = await withSecrets(w, A1, ENV);
    const forged = sealSecrets(
      Buffer.alloc(32, 7),
      { userId: USER, appKey: APP, attemptId: A1 },
      ENV
    );
    w.objects.set(b.secrets.key, forged);
    const res = await commitHibernation(
      { ...body, secrets: { sha256: sha(forged), bytes: forged.length } },
      w.deps
    );
    expect(res).toEqual({ kind: 'mismatch', reason: 'secrets do not decrypt' });
    expect(w.rows.size).toBe(0);
  });

  it('the master key never appears in what begin answers', async () => {
    const w = world();
    const b = await begin(w, A1);
    expect(JSON.stringify(b)).not.toContain(w.deps.masterKey!.toString('base64'));
  });
});

describe('list, wake seed and account deletion', () => {
  it('lists only the viewer’s apps as Sleeping, and a wake seed is a presigned GET with the sha', async () => {
    const w = world();
    const { b, body } = await uploaded(w, A1, ARCHIVE_1);
    await commitHibernation(body, w.deps);

    expect(await listSleepingApps(USER, w.deps)).toMatchObject([
      { app: APP, status: 'Sleeping', bytes: ARCHIVE_1.length, hasSecrets: false },
    ]);
    expect(await listSleepingApps(OTHER_USER, w.deps)).toEqual([]);
    expect(await getWakeSeed(USER, APP, w.deps)).toMatchObject({
      url: `https://store.test/get/${b.archive.key}`,
      sha256: sha(ARCHIVE_1),
      bytes: ARCHIVE_1.length,
    });
    expect(await getWakeSeed(OTHER_USER, APP, w.deps)).toBeNull();
  });

  it('account deletion removes the user’s rows and every object under their prefix, and no one else’s', async () => {
    const w = world();
    const mine = await uploaded(w, A1, ARCHIVE_1);
    await commitHibernation(mine.body, w.deps);
    // An attempt that never committed: an object no row names.
    w.objects.set(`archives/${USER}/other-app/orphan.zip`, Buffer.from('x'));
    const theirs = `archives/${OTHER_USER}/${APP}/${A2}.zip`;
    w.objects.set(theirs, Buffer.from('y'));
    w.rows.set(`${OTHER_USER}/${APP}`, {
      ...w.rows.get(`${USER}/${APP}`)!,
      userId: OTHER_USER,
      objectKey: theirs,
    });

    const res = await deleteSleepingAppsForAccount(USER, {
      repo: w.deps.repo,
      store: w.deps.store,
      isMissingTable: () => false,
    });

    expect(res).toEqual({ rows: 1, objects: 2 });
    expect([...w.rows.keys()]).toEqual([`${OTHER_USER}/${APP}`]);
    expect([...w.objects.keys()]).toEqual([theirs]);
  });

  it('account deletion before the migration is applied still empties the store', async () => {
    const w = world();
    w.objects.set(`archives/${USER}/a-app/x.zip`, Buffer.from('x'));
    w.deps.repo.removeAll = async () => {
      throw Object.assign(new Error('relation "app_sandbox_hibernations" does not exist'), {
        code: '42P01',
      });
    };
    expect(
      await deleteSleepingAppsForAccount(USER, {
        repo: w.deps.repo,
        store: w.deps.store,
        isMissingTable: (e) => (e as { code?: string }).code === '42P01',
      })
    ).toEqual({ rows: 0, objects: 1 });
    expect(w.objects.size).toBe(0);
  });
});
