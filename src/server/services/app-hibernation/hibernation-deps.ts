import { env } from '~/env/server';
import type {
  AttemptRecord,
  AttemptStore,
  HibernationDeps,
} from '~/server/services/app-hibernation/app-hibernation.service';
import { parseMasterKey } from '~/server/services/app-hibernation/secrets-envelope';
import { sleepingAppLimits } from '~/server/services/blocks/user-app-caps.service';
import { archiveStoreConfig, createArchiveStore } from '~/utils/app-archive-s3';
import type { SessionUser } from '~/types/session';

/**
 * The production wiring of `HibernationDeps`: the raw-SQL repo, Redis for attempts and nonces,
 * the S3 archive store, the master key from env, the `app-hibernate` flag and the per-plan
 * limits. Everything heavy is imported lazily, per call.
 */

async function sysRedisClient() {
  const { sysRedis, REDIS_SYS_KEYS } = await import('~/server/redis/client');
  return { sysRedis, keys: REDIS_SYS_KEYS.BLOCKS };
}

const redisAttempts: AttemptStore = {
  async claim(rec, ttlSeconds) {
    const { sysRedis, keys } = await sysRedisClient();
    const key = `${keys.HIBERNATION_ATTEMPT}:${rec.attemptId}` as const;
    const set = await sysRedis.set(key, JSON.stringify(rec), { NX: true, EX: ttlSeconds });
    if (set) return rec;
    const raw = await sysRedis.get(key);
    if (!raw) throw new Error('hibernation attempt vanished between SET NX and GET');
    return JSON.parse(raw) as AttemptRecord;
  },
  async get(attemptId) {
    const { sysRedis, keys } = await sysRedisClient();
    const raw = await sysRedis.get(`${keys.HIBERNATION_ATTEMPT}:${attemptId}` as const);
    return raw ? (JSON.parse(raw) as AttemptRecord) : null;
  },
};

/** Records a request nonce; `true` only the first time. Throws on a redis error (fail closed). */
export async function claimHibernationNonce(nonce: string, ttlSeconds: number): Promise<boolean> {
  const { sysRedis, keys } = await sysRedisClient();
  const set = await sysRedis.set(`${keys.HIBERNATION_NONCE}:${nonce}` as const, '1', {
    NX: true,
    EX: ttlSeconds,
  });
  return !!set;
}

export async function defaultHibernationDeps(): Promise<HibernationDeps> {
  const config = archiveStoreConfig();
  const [{ hibernationRepo }, { isAppHibernateEnabled }] = await Promise.all([
    import('~/server/services/app-hibernation/hibernation.repo'),
    import('~/server/services/app-blocks-flag'),
  ]);
  return {
    repo: hibernationRepo,
    attempts: redisAttempts,
    store: config ? createArchiveStore(config) : null,
    masterKey: parseMasterKey(env.APP_ARCHIVE_SECRETS_MASTER_KEY),
    getUser: async (userId) => {
      const { sessionClient } = await import('~/server/auth/session-client');
      return ((await sessionClient.getSessionUserById(userId)) as SessionUser | null) ?? null;
    },
    isEnabled: (user) => isAppHibernateEnabled({ user }),
    limits: (userId) => sleepingAppLimits(userId),
    now: () => new Date(),
    report: (event, details) => {
      void import('~/server/logging/client')
        .then(({ logToAxiom }) => logToAxiom({ type: event, ...details }))
        .catch(() => undefined);
    },
  };
}
