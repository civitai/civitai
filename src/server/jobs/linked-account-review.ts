import { logToAxiom } from '~/server/logging/client';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { createLinkedAccountReader } from '~/server/services/linked-account-review/read';
import { failUnlessRan, runLinkedAccountReview } from '~/server/services/linked-account-review/run';
import { moderatorApp } from '~/server/services/moderator-app.service';
import { createJob } from './job';

const { CONFIG, FILED } = REDIS_SYS_KEYS.LINKED_ACCOUNT_REVIEW;

export const linkedAccountReview = createJob(
  'linked-account-review',
  '0 13 * * 1',
  async () => {
    const result = await runLinkedAccountReview({
      readConfig: async () => decodeRedisString(await sysRedis.get(CONFIG)),
      reader: createLinkedAccountReader(),
      filed: {
        get: async (signatures) => {
          if (signatures.length === 0) return new Map();
          const values = await sysRedis.hmGet(FILED, signatures);
          const out = new Map<string, string>();
          signatures.forEach((sig, i) => {
            const at = decodeRedisString(values[i]);
            if (at) out.set(sig, at);
          });
          return out;
        },
        set: async (entries) => {
          if (entries.length) await sysRedis.hSet(FILED, Object.fromEntries(entries));
        },
      },
      sendReport: (report) => moderatorApp.abuseReport(report),
      now: () => new Date(),
      log: (type, name, data) => void logToAxiom({ type, name, ...data }).catch(() => undefined),
    });
    return failUnlessRan(result);
  },
  { lockExpiration: 30 * 60 }
);
