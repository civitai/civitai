import type { PrismaClient } from '@prisma/client';
import Rand, { PRNG } from 'rand-seed';
import { dbWrite } from '~/server/db/client';
import { discord } from '~/server/integrations/discord';
import type { EventPointsConfig } from '~/server/events/points/types';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import {
  redis,
  REDIS_KEYS,
  REDIS_SUB_KEYS,
  REDIS_SYS_KEYS,
  sysRedis,
  withSysReadDeadline,
} from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import type { FeatureFlagKey } from '~/server/services/feature-flags.service';

// Disable pod memory keeping for now... We might not need it.
// const manualAssignments: Record<string, Record<string, string>> = {};
async function getManualAssignments(event: string, { strict = false } = {}) {
  // if (manualAssignments[event]) return manualAssignments[event];
  // Fail open: called via getUserTeam → getUserCosmeticId on every
  // user-cosmetic resolution during active events. A sysRedis outage
  // shouldn't 500 every cosmetic lookup — degrade to "no manual
  // assignments" for the outage window.
  try {
    // Wall-clock deadline: this read is on the per-request cosmetic-resolution
    // path during active events; the try/catch only covers a fast DOWN, so a
    // silent half-open would park it ~11min.
    const assignments = await withSysReadDeadline(
      sysRedis.hGetAll(
        `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.MANUAL_ASSIGNMENTS}`
      )
    );
    // manualAssignments[event] = assignments;
    return assignments;
  } catch (err) {
    // Strict callers decide something that must not use a guessed team (selling
    // a team-coloured item), so they get the failure instead of the fallback.
    if (strict) throw err;
    logSysRedisFailOpen('read-degraded', 'getManualAssignments', err, { event });
    return {} as Record<string, string>;
  }
}
export async function addManualAssignments(event: string, team: string, users: string[]) {
  const userIds = await dbWrite.user.findMany({
    where: { username: { in: users } },
    select: { id: true },
  });

  for (const { id } of userIds) {
    await sysRedis.hSet(
      `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.MANUAL_ASSIGNMENTS}`,
      id.toString(),
      team
    );
  }
}

export function createEvent<T>(name: RedisKeyTemplateCache, definition: HolidayEventDefinition) {
  async function getCosmetic(name: string) {
    const cachedCosmeticId = await redis.hGet(REDIS_KEYS.COSMETICS.IDS, name);
    if (cachedCosmeticId) return Number(cachedCosmeticId);
    const cosmetic = await dbWrite.cosmetic.findFirst({
      where: { name: name },
    });
    if (!cosmetic) return;

    await redis.hSet(REDIS_KEYS.COSMETICS.IDS, name, cosmetic.id.toString());
    return cosmetic.id;
  }

  async function getKey<T>(key: string, defaultValue = '{}') {
    const json = (await redis.hGet(name, key)) ?? defaultValue;
    return JSON.parse(json) as T;
  }
  async function setKey(key: string, value: any) {
    await redis.hSet(name, key, JSON.stringify(value));
  }
  async function clearKeys() {
    await redis.del(name);
    await redis.del(`${REDIS_KEYS.EVENT.CACHE}:${name}:${REDIS_SUB_KEYS.EVENT.COSMETICS}`);
  }
  async function getUserTeam(userId: number, opts?: { strict?: boolean }) {
    const manualAssignment = await getManualAssignments(name, opts);
    if (manualAssignment[userId.toString()]) return manualAssignment[userId.toString()];
    const random = new Rand(name + userId.toString(), PRNG.sfc32);
    const number = random.next();
    const index = Math.floor(number * definition.teams.length);
    return definition.teams[index];
  }
  // A join event finds its team cosmetic by data (event, team, design), so cosmetic names stay
  // display-only. Older events find it by the name "<cosmeticName> - <team>".
  async function getTeamCosmetic(team: string) {
    if (!definition.join) return getCosmetic(`${definition.cosmeticName} - ${team}`);

    const field = `${name}:${definition.join.design}:${team}`;
    const cached = await redis.hGet(REDIS_KEYS.COSMETICS.IDS, field);
    if (cached) return Number(cached);
    const [cosmetic] = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Cosmetic"
      WHERE type = 'ContentDecoration'
        AND data->>'event' = ${name}
        AND data->>'team' = ${team}
        AND data->>'design' = ${definition.join.design}
      ORDER BY id
      LIMIT 1
    `;
    if (!cosmetic) return;
    await redis.hSet(REDIS_KEYS.COSMETICS.IDS, field, cosmetic.id.toString());
    return cosmetic.id;
  }
  async function getUserCosmeticId(userId: number) {
    return getTeamCosmetic(await getUserTeam(userId));
  }
  async function clearUserCosmeticCache(userId: number) {
    await redis.hDel(
      `${REDIS_KEYS.EVENT.CACHE}:${name}:${REDIS_SUB_KEYS.EVENT.COSMETICS}`,
      userId.toString()
    );
  }
  async function getRewards() {
    const rewards = await dbWrite.cosmetic.findMany({
      where: { name: { startsWith: definition.badgePrefix }, source: 'Claim', type: 'Badge' },
      select: { id: true, name: true, data: true, description: true },
      orderBy: { id: 'asc' },
    });

    return rewards.map(({ name, ...reward }) => ({
      ...reward,
      name: name.replace(definition.badgePrefix, '').replace(':', '').trim(),
    }));

    return rewards;
  }
  async function getDiscordRoles() {
    const cacheKey =
      `${REDIS_SYS_KEYS.EVENT}:${name}:${REDIS_SUB_KEYS.EVENT.DISCORD_ROLES}` as const;
    // Read fail-open: if sysRedis is unreachable we early-return {}
    // immediately and SKIP the Discord API call. Net result during an
    // outage is "no discord roles for this event" — caller treats the
    // missing map as no-op.
    let roleCache: Record<string, string>;
    try {
      // Wall-clock deadline so a silent half-open can't park this awaited read
      // ~11min (the try/catch only covers a fast DOWN).
      roleCache = await withSysReadDeadline(sysRedis.hGetAll(cacheKey));
    } catch (err) {
      logSysRedisFailOpen('read-degraded', 'getDiscordRoles read', err, { event: name });
      return {} as Record<string, string>;
    }
    if (Object.keys(roleCache).length > 0) return roleCache;

    // Cache is empty, so we need to populate it
    const discordRoles = await discord.getAllRoles();
    for (const team of definition.teams) {
      const role = discordRoles.find((r) => r.name.includes(`(${team})`));
      if (!role) continue;
      roleCache[team] = role.id;
    }
    // Writeback fail-open (only reached when the read succeeded above):
    // we already have the freshly-resolved roles in memory, so a cache-
    // populate failure just means the next call will re-query Discord
    // instead of getting a sysRedis cache hit. Caller gets the same
    // roleCache return value regardless.
    try {
      await sysRedis.hSet(cacheKey, roleCache);
    } catch (err) {
      logSysRedisFailOpen('write-degraded', 'getDiscordRoles writeback', err, { event: name });
    }

    return roleCache;
  }

  return {
    getCosmetic,
    getKey,
    setKey,
    clearKeys,
    clearUserCosmeticCache,
    getTeamCosmetic,
    getUserTeam,
    getUserCosmeticId,
    getRewards,
    getDiscordRoles,
    name,
    ...definition,
  };
}

export type EngagementEvent = {
  userId: number;
  type: 'published' | 'entered';
  entityType: 'post' | 'model' | 'modelVersion' | 'article' | 'challenge';
  entityId: number;
};

export type TeamScore = {
  team: string;
  score: number;
  rank: number;
};

type ProcessingContext = EngagementEvent & {
  db: PrismaClient;
};

type DailyResetContext = {
  scores: TeamScore[];
  db: PrismaClient;
};

type CleanupContext = DailyResetContext & {
  winner: string;
  winnerCosmeticId?: number;
};

export type DonationCosmeticData = {
  donated?: number;
  purchased?: number;
};

export type BuzzEventContext = {
  userId: number;
  amount: number;
  userCosmeticData: DonationCosmeticData;
  db: PrismaClient;
};

// Scores a team by the points its event cosmetics earn: every qualifying action on content wearing
// one is recorded in a ledger and settled hourly. See src/server/events/points/.
export type EventScoring = EventPointsConfig & {
  // Accounts registered less than this many days before the event starts earn nobody points.
  newAccountDays: number;
  // Scoring keeps running this long past endDate for late data; the winner is decided after it.
  finalizeAfterMs: number;
};

// The words a scored event's page shows. The numbers on it (reaction weight, caps, cooldown, what can
// wear a decoration) are read from `scoring` and the event's decoration definition, never restated
// here, so the page cannot drift from the rules the scoring job applies.
export type EventPageCopy = {
  headline: string;
  // A second headline line, drawn in the team-colour gradient.
  headlineAccent?: string;
  // CDN image id for the hero art. Keep its subject on the right: the left side sits under the copy.
  heroImage?: string;
  // Shown verbatim on the hero's date badge, e.g. "Nov 11 to Nov 25"; without it the badge formats
  // startDate and endDate in the viewer's timezone.
  dates?: string;
  summary: string;
  steps: { title: string; body: string }[];
  prize: { title: string; body: string; imageUrl?: string };
  // The prize badge's art per team, as CDN image ids: `animated` for viewers who autoplay, `static`
  // (a still frame) for those who turned autoplay off.
  prizeBadge?: Record<string, { animated: string; static: string }>;
  faq?: { question: string; answer: string }[];
};

// The strip this event shows in the nav announcement slot while the viewer can play it (see
// nav-banner.service.ts). Title and image default to the page's headline and hero.
export type EventBannerCopy = {
  title?: string;
  accent?: string;
  text?: string;
  cta?: string;
  image?: string;
  background?: string;
  dismissible?: boolean;
  priority?: number;
};

type HolidayEventDefinition = {
  title: string;
  page?: EventPageCopy;
  banner?: EventBannerCopy;
  startDate: Date;
  endDate: Date;
  teams: readonly string[];
  // Gates the event behind this flag, with an early window for flagged users. See event-access.ts.
  featureFlag?: FeatureFlagKey;
  previewFrom?: Date;
  // Buzz-bank events score each team by its bank balance. Omit it and set `scoring` instead.
  bankIndex?: number;
  scoring?: EventScoring;
  // Joining grants the team's cosmetic of this design (Cosmetic.data.design) under this claimKey,
  // once per user, only inside the event window. Without it, activateCosmetic keeps the bank-event
  // behaviour.
  join?: { claimKey: string; design: string };
  cosmeticName: string;
  badgePrefix: string;
  coverImage?: string;
  coverImageCollection?: string;
  onCleanup?: (ctx: CleanupContext) => Promise<void>;
  onEngagement?: (ctx: ProcessingContext) => Promise<void>;
  onPurchase?: (ctx: BuzzEventContext) => Promise<void>;
  onDonate?: (ctx: BuzzEventContext) => Promise<void>;
  onDailyReset?: (ctx: DailyResetContext) => Promise<void>;
};
