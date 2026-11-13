import { describe, expect, it } from 'vitest';
import {
  beginHibernation,
  commitHibernation,
  deleteSleepingAppsForAccount,
  mintWakeTicket,
  restoreSleepingAppSecrets,
  sweepOrphanedArchives,
  type BeginResult,
  type CommitInput,
} from '~/server/services/app-hibernation/app-hibernation.service';
import type { HibernationRow } from '~/server/services/app-hibernation/hibernation.repo';
import { beginAnswer, commitAnswer } from '~/server/services/app-hibernation/internal-routes';
import { sleepingAppLimits } from '~/server/services/blocks/user-app-caps.service';
import { defaultUsageLimitConfig } from '~/shared/constants/usage-limits';
import type { SessionUser } from '~/types/session';
import { archiveObjectKeys } from '~/utils/app-archive-s3';
import { NOW, sha, world, type World } from './hibernation.fakes';

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
const uploadKeyOf = (attemptId: string, app = APP, userId = USER) =>
  archiveObjectKeys(userId, app, attemptId);

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

const leftOf = (w: World, attemptId: string) =>
  [...w.objects.keys()].filter((k) => k.startsWith(`archives/${USER}/${APP}/${attemptId}.`));
/** The kept keys of the row, which every commit invocation names uniquely. */
const rowOf = (w: World) => w.rows.get(`${USER}/${APP}`)!;
const KEPT_ZIP = (attemptId: string) =>
  new RegExp(`^archives/${USER}/${APP}/${attemptId}\\.[0-9a-f]{16}\\.kept\\.zip$`);

describe('commit verifies a copy no URL can write, before writing anything', () => {
  it('a tampered object is a 409 mismatch, NO row, and the attempt leaves no object behind', async () => {
    const w = world();
    const { b, body } = await uploaded(w, A1, ARCHIVE_1);
    w.objects.set(b.archive.key, Buffer.from(ARCHIVE_1.toString().replace('first', 'FIRST')));

    expect(await commitHibernation(body, w.deps)).toEqual({
      kind: 'mismatch',
      reason: 'archive sha256 mismatch',
    });
    expect(w.rows.size).toBe(0);
    expect(leftOf(w, A1)).toEqual([]);
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

  it('a copy that streams past the 25 MiB archive limit is refused while hashing', async () => {
    const w = world();
    const { b, body } = await uploaded(w, A1, ARCHIVE_1);
    // The upload is swapped for a huge one between the size check and the copy.
    const store = w.deps.store!;
    const realCopy = store.copy;
    store.copy = async (from, to) => {
      w.objects.set(from, Buffer.alloc(25 * 1024 * 1024 + 1));
      return realCopy(from, to);
    };
    expect(await commitHibernation(body, w.deps)).toEqual({
      kind: 'mismatch',
      reason: 'archive too large',
    });
    expect(w.rows.size).toBe(0);
    expect(b.archive.key).toBe(uploadKeyOf(A1).archive);
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

  it('records the KEPT copy (never the presigned upload key) and deletes the upload', async () => {
    const w = world();
    const { b, body } = await uploaded(w, A1, ARCHIVE_1);
    expect(await commitHibernation(body, w.deps)).toEqual({
      kind: 'committed',
      sha256: sha(ARCHIVE_1),
    });
    const row = w.rows.get(`${USER}/${APP}`)!;
    expect(row).toMatchObject({
      objectKey: expect.stringMatching(KEPT_ZIP(A1)),
      sha256: sha(ARCHIVE_1),
      bytes: ARCHIVE_1.length,
      secretsObjectKey: null,
    });
    expect(b.archive.key).toBe(`archives/${USER}/${APP}/${A1}.zip`);
    expect(w.objects.has(b.archive.key)).toBe(false);
  });

  it('overwriting the upload key AFTER commit (its URL is still valid) cannot change the recorded archive', async () => {
    const w = world();
    const { b, body } = await uploaded(w, A1, ARCHIVE_1);
    await commitHibernation(body, w.deps);
    // The sandbox service (or anyone holding the URL) PUTs again within the URL's TTL.
    w.objects.set(b.archive.key, Buffer.from('PK\x03\x04 something else entirely'));

    const row = w.rows.get(`${USER}/${APP}`)!;
    expect(sha(w.objects.get(row.objectKey)!)).toBe(row.sha256);
  });
});

describe('upsert and lineage', () => {
  it('a retried commit of the same attempt is idempotent: one row, unchanged, nothing deleted', async () => {
    const w = world();
    const { body } = await uploaded(w, A1, ARCHIVE_1);
    const first = await commitHibernation(body, w.deps);
    const rowAfterFirst = { ...w.rows.get(`${USER}/${APP}`) };
    const second = await commitHibernation(body, w.deps);

    expect(second).toEqual(first);
    expect(w.rows.size).toBe(1);
    expect(w.rows.get(`${USER}/${APP}`)).toEqual(rowAfterFirst);
    expect(w.objects.has(rowOf(w).objectKey)).toBe(true);
    expect(w.log.filter((l) => l.startsWith('write'))).toHaveLength(1);
  });

  it('a sandbox NOT woken from the stored record cannot overwrite it (409 lineage), and its objects go', async () => {
    const w = world();
    const first = await uploaded(w, A1, ARCHIVE_1);
    await commitHibernation(first.body, w.deps);
    const second = await uploaded(w, A2, ARCHIVE_2, { sandboxSeedSha: null });

    expect(await commitHibernation(second.body, w.deps)).toEqual({ kind: 'lineage' });
    expect(w.rows.get(`${USER}/${APP}`)?.sha256).toBe(sha(ARCHIVE_1));
    expect(w.objects.has(rowOf(w).objectKey)).toBe(true);
    expect(leftOf(w, A2)).toEqual([]);

    const third = await uploaded(w, '33333333-3333-4333-8333-333333333333', ARCHIVE_2);
    const wrongSeed = { ...third.body, sandboxSeedSha: sha(Buffer.from('some other seed')) };
    expect(await commitHibernation(wrongSeed, w.deps)).toEqual({ kind: 'lineage' });
  });

  it('a sandbox woken from the record replaces it, and the old objects go only AFTER the write', async () => {
    const w = world();
    const first = await uploaded(w, A1, ARCHIVE_1);
    await commitHibernation(first.body, w.deps);
    const firstKept = rowOf(w).objectKey;
    const second = await uploaded(w, A2, ARCHIVE_2, { sandboxSeedSha: sha(ARCHIVE_1) });

    expect(await commitHibernation(second.body, w.deps)).toEqual({
      kind: 'committed',
      sha256: sha(ARCHIVE_2),
    });
    expect(rowOf(w).objectKey).toMatch(KEPT_ZIP(A2));
    expect(w.objects.has(firstKept)).toBe(false);
    const writeAt = w.log.indexOf(`write ${rowOf(w).objectKey}`);
    const deleteAt = w.log.indexOf(`delete ${firstKept}`);
    expect(writeAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(writeAt);
  });
});

describe('per-plan sleeping-app limits', () => {
  // Literal registry defaults per tier, not read from the implementation.
  const EXPECTED: Record<string, { apps: number; bytes: number }> = {
    free: { apps: 5, bytes: 104_857_600 },
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

  /**
   * A world whose limits come from the real resolver, holding `n` sleeping apps of `each` bytes.
   * `held-i` went to sleep i days before 2026-06-01, so the oldest is the LAST one, never the
   * first by key: a refusal that named the wrong app could not pass.
   */
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
        hibernatedAt: new Date(Date.UTC(2026, 5, 1 - i)),
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
        oldest: {
          app: `held-${apps - 1}`,
          hibernatedAt: new Date(Date.UTC(2026, 5, 1 - (apps - 1))).toISOString(),
        },
      } satisfies BeginResult);
      expect(atLimit.attemptsMap.size).toBe(0);

      const below = holding(tier, apps - 1);
      expect(
        (await beginHibernation({ userId: USER, app: APP, attemptId: A1 }, below.deps)).kind
      ).toBe('ok');
    }
  );

  it('the free refusal names the oldest sleeping app (literal payload), and deletes nothing', async () => {
    const w = holding('free', 5);
    const answer = beginAnswer(
      await beginHibernation({ userId: USER, app: APP, attemptId: A1 }, w.deps)
    );
    expect(answer).toEqual({
      status: 409,
      json: {
        error: 'Sleeping app limit reached',
        code: 'SLEEPING_LIMIT',
        limit: { kind: 'apps', limit: 5, used: 5 },
        oldest: { app: 'held-4', hibernatedAt: '2026-05-28T00:00:00.000Z' },
      },
    });
    expect(w.rows.size).toBe(5);
    expect(w.log.filter((l) => l.startsWith('delete') || l.startsWith('remove'))).toEqual([]);
  });

  it('at the app limit, re-hibernating an app that is already sleeping is still allowed', async () => {
    const w = holding('free', 5);
    expect(
      (await beginHibernation({ userId: USER, app: 'held-3', attemptId: A2 }, w.deps)).kind
    ).toBe('ok');
  });

  it('begin refuses once the plan bytes are used up', async () => {
    const full = holding('free', 1, 104_857_600);
    expect(await beginHibernation({ userId: USER, app: APP, attemptId: A1 }, full.deps)).toEqual({
      kind: 'limit',
      limit: { kind: 'bytes', limit: 104_857_600, used: 104_857_600 },
      oldest: { app: 'held-0', hibernatedAt: '2026-06-01T00:00:00.000Z' },
    });
  });

  it('commit refuses an archive that would pass the bytes, names the oldest (literal payload), and removes the attempt', async () => {
    const nearly = holding('free', 2, 52_428_800 - 5);
    const { body } = await uploaded(nearly, A1, Buffer.alloc(11, 1));
    expect(commitAnswer(await commitHibernation(body, nearly.deps))).toEqual({
      status: 409,
      json: {
        error: 'Sleeping app limit reached',
        code: 'SLEEPING_LIMIT',
        limit: { kind: 'bytes', limit: 104_857_600, used: 104_857_590 },
        oldest: { app: 'held-1', hibernatedAt: '2026-05-31T00:00:00.000Z' },
      },
    });
    expect(nearly.rows.has(`${USER}/${APP}`)).toBe(false);
    expect(leftOf(nearly, A1)).toEqual([]);
  });
});

describe('the flag off refuses every endpoint', () => {
  it('begin, commit, the secrets restore and a wake ticket all answer disabled and touch nothing', async () => {
    const w = world();
    const { body } = await uploaded(w, A1, ARCHIVE_1);
    w.state.enabled = false;
    const logBefore = w.log.length;

    expect(await beginHibernation({ userId: USER, app: APP, attemptId: A2 }, w.deps)).toEqual({
      kind: 'disabled',
    });
    expect(await commitHibernation(body, w.deps)).toEqual({ kind: 'disabled' });
    expect(
      await restoreSleepingAppSecrets(
        { userId: USER, app: APP, sha256: sha(ARCHIVE_1), ticket: 'x'.repeat(43) },
        w.deps
      )
    ).toEqual({ kind: 'disabled' });
    expect(await mintWakeTicket(USER, APP, w.deps)).toEqual({ kind: 'disabled' });
    expect(w.rows.size).toBe(0);
    expect(w.attemptsMap.has(A2)).toBe(false);
    expect(w.log.slice(logBefore)).toEqual([]);
  });
});

describe('no public endpoint', () => {
  it('a store that cannot presign answers not-configured, never limit, even for a user at the limit', async () => {
    const w = world();
    w.deps.limits = async () => ({ apps: 0, bytes: 0 });
    (w.deps.store as { canPresign: boolean }).canPresign = false;
    expect(await beginHibernation({ userId: USER, app: APP, attemptId: A1 }, w.deps)).toEqual({
      kind: 'not-configured',
    });
  });

  it('begin answers not-configured and records no attempt when nothing can be presigned', async () => {
    const w = world();
    (w.deps.store as { canPresign: boolean }).canPresign = false;
    expect(await beginHibernation({ userId: USER, app: APP, attemptId: A1 }, w.deps)).toEqual({
      kind: 'not-configured',
    });
    expect(w.attemptsMap.size).toBe(0);
  });
});

describe('deleted and banned accounts', () => {
  it.each(['deleted', 'banned'] as const)('begin refuses a %s account', async (state) => {
    const w = world();
    w.accounts.set(USER, state);
    expect(await beginHibernation({ userId: USER, app: APP, attemptId: A1 }, w.deps)).toEqual({
      kind: 'account-closed',
    });
    expect(w.attemptsMap.size).toBe(0);
  });

  it('a commit after the account was deleted is refused: no row, no object left', async () => {
    const w = world();
    const { body } = await uploaded(w, A1, ARCHIVE_1);
    w.accounts.set(USER, 'deleted');
    expect(await commitHibernation(body, w.deps)).toEqual({ kind: 'account-closed' });
    expect(w.rows.size).toBe(0);
    expect(leftOf(w, A1)).toEqual([]);
  });

  it('a deletion that lands after the early check is still caught inside the transaction', async () => {
    const w = world();
    const { body } = await uploaded(w, A1, ARCHIVE_1);
    // The early read still says active; the deletion commits before the row is written.
    w.deps.repo.accountState = async () => 'active';
    w.accounts.set(USER, 'deleted');
    expect(await commitHibernation(body, w.deps)).toEqual({ kind: 'account-closed' });
    expect(w.rows.size).toBe(0);
    expect(leftOf(w, A1)).toEqual([]);
  });
});

describe('.env* secrets sealed by civitai, and wake tickets', () => {
  // Opaque bytes: civitai never parses them, so they need not even be text.
  const ENV = Buffer.concat([
    Buffer.from('.env\0SECRET=test-only-value\n'),
    Buffer.from([0, 255, 7]),
  ]);

  async function committedWithSecrets(w: World, attemptId = A1, blob = ENV) {
    const { b, body } = await uploaded(w, attemptId, ARCHIVE_1);
    const res = await commitHibernation({ ...body, secretsBlob: blob.toString('base64') }, w.deps);
    return { b, res };
  }

  const restore = (
    w: World,
    ticket: string,
    over: Partial<{ app: string; userId: number; sha256: string }> = {}
  ) =>
    restoreSleepingAppSecrets(
      { userId: USER, app: APP, sha256: sha(ARCHIVE_1), ticket, ...over },
      w.deps
    );

  it('round trip: the blob sealed at commit comes back byte-identical, ONCE, and the release is logged without content', async () => {
    const w = world();
    const { res } = await committedWithSecrets(w);
    expect(res.kind).toBe('committed');
    const row = w.rows.get(`${USER}/${APP}`)!;
    expect(row.secretsObjectKey).toBe(row.objectKey.replace(/\.kept\.zip$/, '.kept.secrets'));
    expect(row.secretsWrappedKey?.startsWith('v2.k1.')).toBe(true);
    // Stored SEALED: the plaintext is not in the object, and the row's sha/bytes describe the object.
    const stored = w.objects.get(row.secretsObjectKey!)!;
    expect(stored.toString('latin1')).not.toContain('test-only-value');
    expect(row.secretsSha256).toBe(sha(stored));
    expect(row.secretsBytes).toBe(stored.length);

    const minted = await mintWakeTicket(USER, APP, w.deps);
    if (minted.kind !== 'ok') throw new Error(minted.kind);
    expect(minted.sha256).toBe(sha(ARCHIVE_1));
    // The store holds a hash of the ticket, never the ticket.
    expect([...w.ticketsMap.keys()]).not.toContain(minted.ticket);

    expect(await restore(w, minted.ticket)).toEqual({ kind: 'ok', blob: ENV.toString('base64') });
    expect(w.reports).toEqual([
      {
        event: 'app-hibernation.secrets-released',
        details: { userId: USER, app: APP, hadSecrets: true },
      },
    ]);
    expect(await restore(w, minted.ticket)).toEqual({ kind: 'ticket' });
  });

  it('no ticket the store knows (never minted, or expired out of it) is refused', async () => {
    const w = world();
    await committedWithSecrets(w);
    expect(await restore(w, 'never-minted-ticket-value-000000000000000')).toEqual({
      kind: 'ticket',
    });
    const minted = await mintWakeTicket(USER, APP, w.deps);
    if (minted.kind !== 'ok') throw new Error(minted.kind);
    w.ticketsMap.clear(); // its TTL ran out
    expect(await restore(w, minted.ticket)).toEqual({ kind: 'ticket' });
  });

  it.each([
    ['another user', { userId: OTHER_USER }],
    ['another app', { app: 'other-app' }],
    ['another archive', { sha256: 'b'.repeat(64) }],
  ])('a ticket presented for %s is refused, and is used up', async (_label, over) => {
    const w = world();
    await committedWithSecrets(w);
    const minted = await mintWakeTicket(USER, APP, w.deps);
    if (minted.kind !== 'ok') throw new Error(minted.kind);
    expect(await restore(w, minted.ticket, over)).toEqual({ kind: 'ticket' });
    expect(await restore(w, minted.ticket)).toEqual({ kind: 'ticket' });
    expect(w.reports.filter((r) => r.event === 'app-hibernation.secrets-released')).toEqual([]);
  });

  it('a record replaced after the ticket was minted answers stale', async () => {
    const w = world();
    await committedWithSecrets(w);
    const minted = await mintWakeTicket(USER, APP, w.deps);
    if (minted.kind !== 'ok') throw new Error(minted.kind);
    w.rows.set(`${USER}/${APP}`, { ...w.rows.get(`${USER}/${APP}`)!, sha256: 'c'.repeat(64) });
    expect(await restore(w, minted.ticket)).toEqual({ kind: 'stale' });
  });

  it('no ticket for an app the user has not got sleeping', async () => {
    const w = world();
    expect(await mintWakeTicket(USER, APP, w.deps)).toEqual({ kind: 'not-found' });
    expect(w.ticketsMap.size).toBe(0);
  });

  it('🔴 overlapping commits of ONE attempt (a slow one and its retry): the row, its objects and the restore all agree', async () => {
    // Reproduction of a review finding: commit A stalls inside the archive hash, the sandbox
    // service retries as B, B completes, then A resumes. Before the fix both wrote the SAME kept
    // keys, so A's sealed secrets replaced B's while the row kept B's wrapped key.
    const w = world();
    const { body } = await uploaded(w, A1, ARCHIVE_1);
    const store = w.deps.store!;
    const realHash = store.hash;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    let calls = 0;
    store.hash = async (key, max) => {
      calls++;
      if (calls === 1) {
        reached();
        await gate;
      }
      return realHash(key, max);
    };
    const full = { ...body, secretsBlob: ENV.toString('base64') };

    const a = commitHibernation(full, w.deps);
    await atGate;
    const bRes = await commitHibernation(full, w.deps);
    release();
    const aRes = await a;

    const committed = { kind: 'committed', sha256: sha(ARCHIVE_1) };
    expect(bRes).toEqual(committed);
    expect(aRes).toEqual(committed);
    const row = w.rows.get(`${USER}/${APP}`)!;
    expect(sha(w.objects.get(row.objectKey)!)).toBe(row.sha256);
    expect(sha(w.objects.get(row.secretsObjectKey!)!)).toBe(row.secretsSha256);
    const minted = await mintWakeTicket(USER, APP, w.deps);
    if (minted.kind !== 'ok') throw new Error(minted.kind);
    expect(await restore(w, minted.ticket)).toEqual({ kind: 'ok', blob: ENV.toString('base64') });
    // The loser removed its own copies: the only kept objects left are the row's.
    expect([...w.objects.keys()].filter((k) => k.includes('.kept.')).sort()).toEqual(
      [row.objectKey, row.secretsObjectKey!].sort()
    );
  });

  it('an account-closed refusal still burns the ticket: it never works again, even after reinstatement', async () => {
    const w = world();
    await committedWithSecrets(w);
    const minted = await mintWakeTicket(USER, APP, w.deps);
    if (minted.kind !== 'ok') throw new Error(minted.kind);
    w.accounts.set(USER, 'banned');
    expect(await restore(w, minted.ticket)).toEqual({ kind: 'account-closed' });
    w.accounts.set(USER, 'active');
    expect(await restore(w, minted.ticket)).toEqual({ kind: 'ticket' });
    expect(w.reports.filter((r) => r.event === 'app-hibernation.secrets-released')).toEqual([]);
  });

  it.each([
    ['blob vs a different blob', ENV, Buffer.from('.env\0SECRET=another-test-value\n')],
    ['blob vs none', ENV, null],
    ['none vs blob', null, ENV],
  ])(
    'a losing invocation with the same archive but different secrets (%s) gets the conflict, and its objects go',
    async (_label, winnerBlob, loserBlob) => {
      const w = world();
      const { body } = await uploaded(w, A1, ARCHIVE_1);
      const store = w.deps.store!;
      const realHash = store.hash;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const atGate = new Promise<void>((r) => (reached = r));
      let calls = 0;
      store.hash = async (key, max) => {
        calls++;
        if (calls === 1) {
          reached();
          await gate;
        }
        return realHash(key, max);
      };
      const withBlob = (blob: Buffer | null) =>
        blob ? { ...body, secretsBlob: blob.toString('base64') } : body;
      const loser = commitHibernation(withBlob(loserBlob), w.deps);
      await atGate;
      expect(await commitHibernation(withBlob(winnerBlob), w.deps)).toEqual({
        kind: 'committed',
        sha256: sha(ARCHIVE_1),
      });
      release();
      expect(await loser).toEqual({ kind: 'mismatch', reason: 'attempt already committed' });
      const row = rowOf(w);
      expect(leftOf(w, A1).sort()).toEqual(
        [row.objectKey, row.secretsObjectKey].filter((k): k is string => !!k).sort()
      );
    }
  );

  it('a losing invocation whose content differs from the winner’s gets the conflict, and its objects go', async () => {
    const w = world();
    const { b, body } = await uploaded(w, A1, ARCHIVE_1);
    const store = w.deps.store!;
    const realHash = store.hash;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    let calls = 0;
    store.hash = async (key, max) => {
      calls++;
      if (calls === 1) {
        reached();
        await gate;
      }
      return realHash(key, max);
    };
    // A copied ARCHIVE_1 and stalls; the upload is then replaced and B commits the new content.
    const a = commitHibernation(body, w.deps);
    await atGate;
    w.objects.set(b.archive.key, ARCHIVE_2);
    const bBody = { ...body, sha256: sha(ARCHIVE_2), bytes: ARCHIVE_2.length };
    expect(await commitHibernation(bBody, w.deps)).toEqual({
      kind: 'committed',
      sha256: sha(ARCHIVE_2),
    });
    release();
    expect(await a).toEqual({ kind: 'mismatch', reason: 'attempt already committed' });
    const row = rowOf(w);
    expect(row.sha256).toBe(sha(ARCHIVE_2));
    expect(leftOf(w, A1)).toEqual([row.objectKey]);
  });

  it.each(['deleted', 'banned'] as const)(
    'no wake ticket is minted for a %s account',
    async (state) => {
      const w = world();
      await committedWithSecrets(w);
      w.accounts.set(USER, state);
      expect(await mintWakeTicket(USER, APP, w.deps)).toEqual({ kind: 'account-closed' });
      expect(w.ticketsMap.size).toBe(0);
    }
  );

  it.each(['deleted', 'banned'] as const)(
    'a ticket minted before the account was %s releases nothing',
    async (state) => {
      const w = world();
      await committedWithSecrets(w);
      const minted = await mintWakeTicket(USER, APP, w.deps);
      if (minted.kind !== 'ok') throw new Error(minted.kind);
      w.accounts.set(USER, state);
      expect(await restore(w, minted.ticket)).toEqual({ kind: 'account-closed' });
      expect(w.reports.filter((r) => r.event === 'app-hibernation.secrets-released')).toEqual([]);
    }
  );

  it('a blob over 64 KiB (decoded) is refused, with NO row and no object left; 64 KiB exactly is kept', async () => {
    const w = world();
    const { body } = await uploaded(w, A1, ARCHIVE_1);
    const res = await commitHibernation(
      { ...body, secretsBlob: Buffer.alloc(65_537, 1).toString('base64') },
      w.deps
    );
    expect(commitAnswer(res)).toEqual({
      status: 413,
      json: { error: 'The secrets blob is too large', code: 'secrets_too_large', limit: 65_536 },
    });
    expect(w.rows.size).toBe(0);
    expect(leftOf(w, A1)).toEqual([]);

    const w2 = world();
    expect((await committedWithSecrets(w2, A1, Buffer.alloc(65_536, 1))).res.kind).toBe(
      'committed'
    );
  });

  it('a failure to store the sealed secrets writes NO row and leaves no object', async () => {
    const w = world();
    const { body } = await uploaded(w, A1, ARCHIVE_1);
    w.storeState.failPuts = true;
    expect(
      await commitHibernation({ ...body, secretsBlob: ENV.toString('base64') }, w.deps)
    ).toEqual({ kind: 'secrets-store-failed' });
    expect(w.rows.size).toBe(0);
    expect(w.log.filter((l) => l.startsWith('write'))).toEqual([]);
    expect(leftOf(w, A1)).toEqual([]);
  });

  it('a commit with no blob records no secrets, and the restore answers blob null', async () => {
    const w = world();
    const { body } = await uploaded(w, A1, ARCHIVE_1);
    await commitHibernation(body, w.deps);
    expect(w.rows.get(`${USER}/${APP}`)?.secretsObjectKey).toBeNull();
    const minted = await mintWakeTicket(USER, APP, w.deps);
    if (minted.kind !== 'ok') throw new Error(minted.kind);
    expect(await restore(w, minted.ticket)).toEqual({ kind: 'ok', blob: null });
  });

  it('begin answers exactly the archive upload: no key material, no secrets upload', async () => {
    const w = world();
    const b = await begin(w, A1);
    expect(Object.keys(b).sort()).toEqual(['archive', 'expiresAt', 'kind', 'maxBytes']);
    expect(Object.keys(b.archive).sort()).toEqual(['key', 'url']);
    expect(Object.keys(beginAnswer(b).json).sort()).toEqual(['archive', 'expiresAt', 'maxBytes']);
  });

  it('no master key appears in what begin answers', async () => {
    const w = world();
    const b = await begin(w, A1);
    const answer = JSON.stringify(b);
    for (const key of w.deps.masterKeys!.keys.values())
      expect(answer).not.toContain(key.toString('base64'));
  });
});

describe('account deletion', () => {
  it('removes the user’s objects FIRST, then the rows, and nobody else’s', async () => {
    const w = world();
    const mine = await uploaded(w, A1, ARCHIVE_1);
    await commitHibernation(mine.body, w.deps);
    w.objects.set(`archives/${USER}/other-app/orphan.zip`, Buffer.from('x'));
    const theirs = `archives/${OTHER_USER}/${APP}/${A2}.kept.zip`;
    w.objects.set(theirs, Buffer.from('y'));
    w.rows.set(`${OTHER_USER}/${APP}`, {
      ...w.rows.get(`${USER}/${APP}`)!,
      userId: OTHER_USER,
      objectKey: theirs,
    });
    const logBefore = w.log.length;

    const res = await deleteSleepingAppsForAccount(USER, {
      repo: w.deps.repo,
      store: w.deps.store,
      isMissingTable: () => false,
    });

    expect(res).toEqual({ rows: 1, objects: 2 });
    expect([...w.rows.keys()]).toEqual([`${OTHER_USER}/${APP}`]);
    expect([...w.objects.keys()]).toEqual([theirs]);
    const after = w.log.slice(logBefore);
    expect(after.findIndex((l) => l.startsWith('delete'))).toBeLessThan(
      after.indexOf(`remove-rows ${USER}`)
    );
  });

  it('a store failure throws and keeps the rows as the record; the sweep then finishes the job', async () => {
    const w = world();
    const mine = await uploaded(w, A1, ARCHIVE_1);
    await commitHibernation(mine.body, w.deps);
    w.accounts.set(USER, 'deleted');
    w.storeState.failDeletes = true;
    const deps = { repo: w.deps.repo, store: w.deps.store, isMissingTable: () => false };

    await expect(deleteSleepingAppsForAccount(USER, deps)).rejects.toThrow(/store unavailable/);
    expect(w.rows.has(`${USER}/${APP}`)).toBe(true);
    expect(w.objects.has(rowOf(w).objectKey)).toBe(true);

    w.storeState.failDeletes = false;
    const swept = await sweepOrphanedArchives({
      ...w.deps,
      isMissingTable: () => false,
      isUnderLegalHold: async () => false,
    });
    expect(swept.accountsRetried).toEqual([USER]);
    expect(w.rows.size).toBe(0);
    expect([...w.objects.keys()].filter((k) => k.startsWith(`archives/${USER}/`))).toEqual([]);
  });

  it('before the migration is applied it still empties the store', async () => {
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

  it('with no store configured it keeps the rows and throws rather than orphan their objects', async () => {
    const w = world();
    const mine = await uploaded(w, A1, ARCHIVE_1);
    await commitHibernation(mine.body, w.deps);
    await expect(
      deleteSleepingAppsForAccount(USER, {
        repo: w.deps.repo,
        store: null,
        isMissingTable: () => false,
      })
    ).rejects.toThrow(/not configured/);
    expect(w.rows.size).toBe(1);
  });
});

describe('orphan sweep', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const row = (objectKey: string): HibernationRow => ({
    userId: USER,
    appKey: 'kept-app',
    attemptId: A1,
    objectKey,
    sha256: 'a'.repeat(64),
    bytes: 1,
    excluded: [],
    secretsObjectKey: `${objectKey}.secrets`,
    secretsSha256: 'b'.repeat(64),
    secretsBytes: 1,
    secretsWrappedKey: 'v2.k1.x',
    reason: null,
    appCreatedAt: null,
    lastActivityAt: null,
    hibernatedAt: ago(30 * DAY),
  });

  function sweepWorld() {
    const w = world();
    const referenced = `archives/${USER}/kept-app/${A1}.kept.zip`;
    w.rows.set(`${USER}/kept-app`, row(referenced));
    const put = (key: string, age: number) => {
      w.objects.set(key, Buffer.from(key));
      w.times.set(key, ago(age));
    };
    // NEGATIVE CONTROL: referenced, and far older than the cutoff.
    put(referenced, 30 * DAY);
    put(`${referenced}.secrets`, 30 * DAY);
    put(`archives/${USER}/gone-app/${A2}.zip`, DAY + 1); // never committed, old
    put(`archives/${OTHER_USER}/x-app/old.kept.zip`, 3 * DAY); // superseded, delete failed
    put(`archives/${USER}/fresh-app/${A2}.zip`, DAY - 60_000); // an attempt still in flight
    return { w, referenced };
  }
  const deps = (w: World) => ({
    ...w.deps,
    isMissingTable: () => false,
    isUnderLegalHold: async () => false,
  });

  it('deletes only unreferenced objects older than 24 h, never a referenced key', async () => {
    const { w, referenced } = sweepWorld();
    const res = await sweepOrphanedArchives(deps(w));
    expect(res.orphans.sort()).toEqual([
      `archives/${USER}/gone-app/${A2}.zip`,
      `archives/${OTHER_USER}/x-app/old.kept.zip`,
    ]);
    expect([...w.objects.keys()].sort()).toEqual(
      [referenced, `${referenced}.secrets`, `archives/${USER}/fresh-app/${A2}.zip`].sort()
    );
  });

  it('a dry run reports the same orphans and deletes nothing', async () => {
    const { w } = sweepWorld();
    const before = [...w.objects.keys()].sort();
    const res = await sweepOrphanedArchives(deps(w), { dryRun: true });
    expect(res.orphans).toHaveLength(2);
    expect([...w.objects.keys()].sort()).toEqual(before);
  });

  it('an unreadable reference set aborts the sweep instead of deleting blind', async () => {
    const { w } = sweepWorld();
    const before = [...w.objects.keys()].sort();
    w.deps.repo.referencedKeys = async () => {
      throw new Error('database unavailable');
    };
    await expect(sweepOrphanedArchives(deps(w))).rejects.toThrow(/database unavailable/);
    expect([...w.objects.keys()].sort()).toEqual(before);
  });
});
