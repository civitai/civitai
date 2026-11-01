import { registerCounterWithLabels } from '~/server/prom/client';
import type { RedisKeyTemplateSys } from '~/server/redis/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/**
 * Known external image hosts, each a bucket matching its domains and their subdomains. Any other
 * host is `other`, so the label set stays fixed and no raw hostname is emitted.
 */
const HOST_BUCKETS: ReadonlyArray<readonly [bucket: string, domains: readonly string[]]> = [
  ['discord', ['discordapp.com', 'discordapp.net', 'discord.com']],
  ['imgur', ['imgur.com']],
  ['google', ['googleusercontent.com', 'ggpht.com', 'drive.google.com']],
  ['twitter', ['twimg.com']],
  ['reddit', ['redd.it', 'redditmedia.com']],
  ['pinterest', ['pinimg.com']],
  ['pixiv', ['pximg.net']],
  ['catbox', ['catbox.moe']],
  ['imgbb', ['ibb.co']],
  ['postimg', ['postimg.cc']],
  ['huggingface', ['huggingface.co', 'hf.co']],
  ['github', ['githubusercontent.com', 'github.com']],
  ['aws_s3', ['amazonaws.com']],
  ['gcs', ['storage.googleapis.com']],
  ['azure_blob', ['blob.core.windows.net']],
  ['cloudflare_r2', ['r2.dev', 'r2.cloudflarestorage.com']],
  ['openai', ['oaiusercontent.com']],
  ['fal', ['fal.media']],
  ['replicate', ['replicate.delivery']],
];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** The bucket of an external url's host: a known host name, `ip` for an IP literal, or `other`. */
export function externalHostBucket(url: string) {
  let hostname: string;
  try {
    hostname = new URL(url.trim()).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return 'other';
  }
  if (IPV4.test(hostname) || hostname.startsWith('[')) return 'ip';
  for (const [bucket, domains] of HOST_BUCKETS)
    if (domains.some((d) => hostname === d || hostname.endsWith(`.${d}`))) return bucket;
  return 'other';
}

const externalHostCounter = registerCounterWithLabels({
  name: 'generation_input_external_hosts_total',
  help:
    'Generation input urls on an external host, by entry point, caller type, mode (log while ' +
    'external hosts are allowed, refuse once they are not) and host bucket.',
  labelNames: ['entry', 'caller', 'mode', 'host'] as const,
});

const externalHostUsersCounter = registerCounterWithLabels({
  name: 'generation_input_external_host_users_total',
  help:
    'Users counted for the first time in a UTC day as sending a generation input url on an ' +
    'external host bucket, by caller type and host bucket. increase over a day = distinct users.',
  labelNames: ['caller', 'host'] as const,
});

const externalHostUsersFailedCounter = registerCounterWithLabels({
  name: 'generation_input_external_host_users_failed_total',
  help: 'Distinct-user set writes for generation input external hosts that failed (not counted).',
  labelNames: ['caller'] as const,
});

const USERS_TTL_SECONDS = 2 * 24 * 60 * 60;

const usersKey = (day: string, caller: string, bucket: string) =>
  `${REDIS_SYS_KEYS.SYSTEM.GENERATION_INPUT_EXTERNAL_HOST_USERS}:${day}:${caller}:${bucket}` as RedisKeyTemplateSys;

async function addUser(key: RedisKeyTemplateSys, userId: number, caller: string, bucket: string) {
  // A HyperLogLog keeps no ids. PFADD answers 1 when the set's estimate changed, which for a
  // set of up to about a thousand users is when the user is new to it.
  if ((await sysRedis.pfAdd(key, String(userId))) === 1) {
    externalHostUsersCounter.inc({ caller, host: bucket });
    await sysRedis.expire(key, USERS_TTL_SECONDS, 'NX');
  }
}

/**
 * Counts one external generation input url by host bucket, and adds the user to that bucket's
 * distinct-user set for the day. `seen` holds the buckets this request already added the user to.
 * Never throws and never waits on Redis: the set write runs in the background and fails open.
 */
export function recordExternalHost({
  url,
  entry,
  caller,
  mode,
  userId,
  now = new Date(),
  seen,
}: {
  url: string;
  entry: string;
  caller: 'api' | 'session';
  mode: 'log' | 'refuse';
  userId: number;
  now?: Date;
  seen: Set<string>;
}) {
  const bucket = externalHostBucket(url);
  externalHostCounter.inc({ entry, caller, mode, host: bucket });
  if (seen.has(bucket)) return;
  seen.add(bucket);
  const key = usersKey(now.toISOString().slice(0, 10), caller, bucket);
  void addUser(key, userId, caller, bucket).catch(() =>
    externalHostUsersFailedCounter.inc({ caller })
  );
}
