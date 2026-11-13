import { createHash, randomBytes } from 'node:crypto';
import type { SessionUser } from '~/types/session';
import type { ArchiveStore } from '~/utils/app-archive-s3';
import type {
  AttemptRecord,
  AttemptStore,
  HibernationDeps,
} from '~/server/services/app-hibernation/app-hibernation.service';
import type {
  HibernationRepo,
  HibernationRow,
} from '~/server/services/app-hibernation/hibernation.repo';

/**
 * In-memory stand-ins for the hibernation service's boundaries. Every call that changes state
 * is appended to `log`, so a test can assert ORDER (nothing deleted before the row is written).
 */

export const sha = (b: Buffer) => createHash('sha256').update(new Uint8Array(b)).digest('hex');

export function fakeStore(log: string[]) {
  const objects = new Map<string, Buffer>();
  const store: ArchiveStore = {
    presignPut: async (key) => `https://store.test/put/${key}`,
    head: async (key) => {
      const o = objects.get(key);
      return o ? { bytes: o.length } : null;
    },
    hash: async (key) => {
      const o = objects.get(key);
      log.push(`hash ${key}`);
      return o ? { sha256: sha(o), bytes: o.length } : null;
    },
    read: async (key, max) => {
      const o = objects.get(key);
      if (o && o.length > max) throw new Error('too large');
      return o ?? null;
    },
    deleteMany: async (keys) => {
      for (const k of keys) {
        log.push(`delete ${k}`);
        objects.delete(k);
      }
    },
    list: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)),
  };
  return { store, objects };
}

export function fakeRepo(log: string[]) {
  const rows = new Map<string, HibernationRow>();
  const id = (userId: number, appKey: string) => `${userId}/${appKey}`;
  const usage = (userId: number, exclude: string) => {
    const mine = [...rows.values()].filter((r) => r.userId === userId && r.appKey !== exclude);
    return { apps: mine.length, bytes: mine.reduce((s, r) => s + r.bytes, 0) };
  };
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
      const d = decide(rows.get(id(userId, appKey)) ?? null, usage(userId, appKey));
      if (d.write) {
        log.push(`write ${d.write.objectKey}`);
        rows.set(id(userId, appKey), { ...d.write });
      }
      return d.result;
    },
    removeAll: async (userId) => {
      const mine = [...rows.values()].filter((r) => r.userId === userId);
      for (const r of mine) rows.delete(id(r.userId, r.appKey));
      log.push(`remove-rows ${userId}`);
      return mine;
    },
  };
  return { repo, rows };
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
  const state = { enabled: opts.enabled ?? true, tier: opts.tier ?? 'free' };
  const masterKey = randomBytes(32);
  const reports: string[] = [];
  const deps: HibernationDeps = {
    repo: r.repo,
    attempts: a.attempts,
    store: s.store,
    masterKey,
    getUser: async (userId) => ({ id: userId, tier: state.tier } as unknown as SessionUser),
    isEnabled: async () => state.enabled,
    limits: async () => ({ apps: 1_000, bytes: 10 * 1024 * 1024 * 1024 }),
    now: () => new Date('2026-11-12T12:00:00.000Z'),
    report: (event) => reports.push(event),
  };
  return { deps, log, state, reports, objects: s.objects, rows: r.rows, attemptsMap: a.map };
}
