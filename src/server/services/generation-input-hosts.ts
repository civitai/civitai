import { registerCounterWithLabels, registerGaugeWithLabels } from '~/server/prom/client';
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

const externalHostUsersGauge = registerGaugeWithLabels({
  name: 'generation_input_external_host_users',
  help:
    'Estimated distinct users who sent a generation input url on an external host bucket in a ' +
    'UTC day (HyperLogLog, about 1% error), by day, caller type and host bucket. Each pod reports ' +
    'the latest estimate it read for the current day only: take the max across pods.',
  labelNames: ['day', 'caller', 'host'] as const,
});

const externalHostUsersFailedCounter = registerCounterWithLabels({
  name: 'generation_input_external_host_users_failed_total',
  help: 'Failed distinct-user set writes or reads for generation input external hosts.',
  labelNames: ['caller'] as const,
});

const DAY_MS = 24 * 60 * 60 * 1000;
// Users this process already added today, so a repeat request writes nothing.
const RECENT_MAX = 50_000;
let recentDay = '';
const recent = new Set<string>();

const usersKey = (day: string, caller: string, bucket: string) =>
  `${REDIS_SYS_KEYS.SYSTEM.GENERATION_INPUT_EXTERNAL_HOST_USERS}:${day}:${caller}:${bucket}` as RedisKeyTemplateSys;

async function addUser(day: string, userId: number, caller: string, bucket: string) {
  const key = usersKey(day, caller, bucket);
  // A HyperLogLog keeps no ids. PFADD answers 1 when the set's estimate changed.
  const changed = (await sysRedis.pfAdd(key, String(userId))) === 1;
  // A fixed expiry a day after the day ends, set on every add so a failed one is set again.
  await sysRedis.expireAt(key, new Date(Date.parse(day) + 2 * DAY_MS));
  if (!changed) return;
  const estimate = await sysRedis.pfCount(key);
  if (day === recentDay) externalHostUsersGauge.set({ day, caller, host: bucket }, estimate);
}

/**
 * Counts one external generation input url by host bucket, and adds the user to that bucket's
 * distinct-user set for the day (once per user, bucket and day in this process).
 * Never throws and never waits on Redis: the set write runs in the background and fails open.
 */
export function recordExternalHost({
  url,
  entry,
  caller,
  mode,
  userId,
  now = new Date(),
}: {
  url: string;
  entry: string;
  caller: 'api' | 'session';
  mode: 'log' | 'refuse';
  userId: number;
  now?: Date;
}) {
  const bucket = externalHostBucket(url);
  externalHostCounter.inc({ entry, caller, mode, host: bucket });

  const day = now.toISOString().slice(0, 10);
  if (day !== recentDay) {
    // A new day: the old day's estimates stop being reported by this pod.
    recentDay = day;
    recent.clear();
    externalHostUsersGauge.reset();
  }
  const member = `${caller}:${bucket}:${userId}`;
  if (recent.has(member)) return;
  if (recent.size >= RECENT_MAX) recent.clear();
  recent.add(member);
  void addUser(day, userId, caller, bucket).catch(() => {
    recent.delete(member);
    externalHostUsersFailedCounter.inc({ caller });
  });
}

/** Test seam: forget the users this process added. */
export function __resetRecentExternalHostUsersForTest() {
  recentDay = '';
  recent.clear();
}
