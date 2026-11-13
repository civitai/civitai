import { createHash, randomBytes } from 'node:crypto';
import type { SessionUser } from '~/types/session';
import { ArchiveObjectTooLarge, type ArchiveStore } from '~/utils/app-archive-s3';
import type {
  AttemptRecord,
  AttemptStore,
  HibernationDeps,
  WakeTicketRecord,
  WakeTicketStore,
} from '~/server/services/app-hibernation/app-hibernation.service';
import type {
  AccountState,
  HibernationRepo,
  HibernationRow,
} from '~/server/services/app-hibernation/hibernation.repo';
import type { MasterKeyring } from '~/server/services/app-hibernation/secrets-envelope';

/**
 * In-memory stand-ins for the hibernation service's boundaries. Every call that changes state
 * is appended to `log`, so a test can assert ORDER (nothing deleted before the row is written).
 */

export const sha = (b: Buffer) => createHash('sha256').update(new Uint8Array(b)).digest('hex');

/** The fake clock every world uses. */
export const NOW = new Date('2026-11-12T12:00:00.000Z');

export function fakeStore(log: string[]) {
  const objects = new Map<string, Buffer>();
  /** Last-written time per key; a key written without one reads as written at {@link NOW}. */
  const times = new Map<string, Date>();
  const state = { failDeletes: false, failPuts: false };
  const store: ArchiveStore = {
    canPresign: true,
    presignPut: async (key) => `https://store.test/put/${key}`,
    head: async (key) => {
      const o = objects.get(key);
      return o ? { bytes: o.length } : null;
    },
    hash: async (key, max) => {
      const o = objects.get(key);
      log.push(`hash ${key}`);
      if (o && o.length > max) throw new ArchiveObjectTooLarge('too large');
      return o ? { sha256: sha(o), bytes: o.length } : null;
    },
    read: async (key, max) => {
      const o = objects.get(key);
      if (o && o.length > max) throw new ArchiveObjectTooLarge('too large');
      return o ?? null;
    },
    put: async (key, body) => {
      if (state.failPuts) throw new Error('store unavailable');
      log.push(`put ${key}`);
      objects.set(key, Buffer.from(body));
      times.set(key, NOW);
    },
    copy: async (from, to) => {
      const o = objects.get(from);
      if (!o) return false;
      log.push(`copy ${from} -> ${to}`);
      objects.set(to, Buffer.from(o));
      times.set(to, NOW);
      return true;
    },
    deleteMany: async (keys) => {
      if (state.failDeletes) throw new Error('store unavailable');
      for (const k of keys) {
        log.push(`delete ${k}`);
        objects.delete(k);
        times.delete(k);
      }
    },
    list: async (prefix) =>
      [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key, lastModified: times.get(key) ?? NOW })),
  };
  return { store, objects, times, state };
}

export function fakeRepo(log: string[]) {
  const rows = new Map<string, HibernationRow>();
  const accounts = new Map<number, AccountState>();
  const id = (userId: number, appKey: string) => `${userId}/${appKey}`;
  const usage = (userId: number, exclude: string) => {
    const mine = [...rows.values()].filter((r) => r.userId === userId && r.appKey !== exclude);
    return { apps: mine.length, bytes: mine.reduce((s, r) => s + r.bytes, 0) };
  };
  const accountOf = (userId: number) => accounts.get(userId) ?? 'active';
  const repo: HibernationRepo = {
    oldest: async (userId, exclude) => {
      const mine = [...rows.values()]
        .filter((r) => r.userId === userId && r.appKey !== exclude)
        .sort(
          (a, b) =>
            a.hibernatedAt.getTime() - b.hibernatedAt.getTime() || a.appKey.localeCompare(b.appKey)
        );
      return mine[0] ? { app: mine[0].appKey, hibernatedAt: mine[0].hibernatedAt } : null;
    },
    get: async (userId, appKey) => rows.get(id(userId, appKey)) ?? null,
    usage: async (userId, exclude) => usage(userId, exclude),
    commit: async (userId, appKey, decide) => {
      const d = decide(
        rows.get(id(userId, appKey)) ?? null,
        usage(userId, appKey),
        accountOf(userId)
      );
      if (d.write) {
        log.push(`write ${d.write.objectKey}`);
        rows.set(id(userId, appKey), { ...d.write });
      }
      return d.result;
    },
    accountState: async (userId) => accountOf(userId),
    removeAll: async (userId) => {
      const mine = [...rows.values()].filter((r) => r.userId === userId);
      for (const r of mine) rows.delete(id(r.userId, r.appKey));
      log.push(`remove-rows ${userId}`);
      return mine;
    },
    referencedKeys: async (keys) => {
      const refs = new Set(
        [...rows.values()].flatMap((r) => [r.objectKey, r.secretsObjectKey]).filter(Boolean)
      );
      return new Set(keys.filter((k) => refs.has(k)));
    },
    deletedAccountsWithRows: async (limit) =>
      [...new Set([...rows.values()].map((r) => r.userId))]
        .filter((u) => accountOf(u) === 'deleted')
        .sort((a, b) => a - b)
        .slice(0, limit),
  };
  return { repo, rows, accounts };
}

export function fakeAttempts() {
  const map = new Map<string, AttemptRecord>();
  const attempts: AttemptStore = {
    claim: async (rec) => {
      const had = map.get(rec.attemptId);
      if (had) return had;
      map.set(rec.attemptId, rec);
      return rec;
    },
    get: async (attemptId) => map.get(attemptId) ?? null,
  };
  return { attempts, map };
}

export function fakeTickets() {
  const map = new Map<string, WakeTicketRecord>();
  const tickets: WakeTicketStore = {
    put: async (hash, rec) => {
      map.set(hash, rec);
    },
    take: async (hash) => {
      const rec = map.get(hash) ?? null;
      map.delete(hash);
      return rec;
    },
  };
  return { tickets, map };
}

export function keyring(...kids: string[]): MasterKeyring {
  const keys = new Map(kids.map((kid) => [kid, randomBytes(32)] as const));
  const [kid] = kids;
  return { current: { kid, key: keys.get(kid)! }, keys };
}

export type World = ReturnType<typeof world>;

/**
 * One wired service: the user's tier and the flag are settable per test. `limits` defaults to a
 * fixed small plan so tests that are not about limits never reach one.
 */
export function world(opts: { enabled?: boolean; tier?: string } = {}) {
  const log: string[] = [];
  const s = fakeStore(log);
  const r = fakeRepo(log);
  const a = fakeAttempts();
  const t = fakeTickets();
  const state = { enabled: opts.enabled ?? true, tier: opts.tier ?? 'free' };
  const reports: { event: string; details: Record<string, unknown> }[] = [];
  const deps: HibernationDeps = {
    repo: r.repo,
    attempts: a.attempts,
    tickets: t.tickets,
    store: s.store,
    masterKeys: keyring('k1'),
    getUser: async (userId) => ({ id: userId, tier: state.tier } as unknown as SessionUser),
    isEnabled: async () => state.enabled,
    limits: async () => ({ apps: 1_000, bytes: 10 * 1024 * 1024 * 1024 }),
    now: () => NOW,
    report: (event, details) => reports.push({ event, details }),
  };
  return {
    deps,
    log,
    state,
    reports,
    objects: s.objects,
    times: s.times,
    storeState: s.state,
    rows: r.rows,
    accounts: r.accounts,
    attemptsMap: a.map,
    ticketsMap: t.map,
  };
}
