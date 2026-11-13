import { utc } from '@civitai/db/kysely';
import { REDIS_SYS_KEYS } from '@civitai/redis';
import {
  KNIGHTS_NSFW_LEVEL_QUESTION,
  readKnightsSourcesConfig,
  type KnightsSourcesConfig,
} from '@civitai/shared/new-order';
import { dbRead, dbWrite } from '../db';
import { recordModActivity, withModerators } from '../mod-activity';
import { getSysRedis } from '../redis';
import { countInquisitorQueue } from './inquisitor.service';

/** One audit stream for the one key: `ModActivity` rows with this entity pair, newest first. */
export const SOURCES_AUDIT_ENTITY = { type: 'KnightsSources', id: 1 } as const;
export const SOURCES_AUDIT_ACTIVITY = 'knights.sources.update';

export type SourcesSettings = {
  config: KnightsSourcesConfig;
  /** False when the key is absent or unreadable: it reads as off and no rates have been chosen. */
  stored: boolean;
};

export type SourcesChange = {
  at: Date;
  moderatorId: number | null;
  moderatorUsername: string | null;
  before: KnightsSourcesConfig | null;
  after: KnightsSourcesConfig | null;
};

export type SaveOutcome = { ok: true; changed: boolean } | { ok: false; error: string };

export async function getSourcesSettings(): Promise<SourcesSettings> {
  const raw = await getSysRedis().get(REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES);
  return readKnightsSourcesConfig(raw);
}

const isRate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Nothing is coerced: a string "true" or a rate of 5 is a bug in the caller, not an intent to guess at. */
export function validateSourcesInput(
  input: unknown
): { ok: true; config: KnightsSourcesConfig } | { ok: false; error: string } {
  const value = (input ?? {}) as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean') return { ok: false, error: 'Enabled must be on or off.' };
  if (!isRate(value.sfwRate)) return { ok: false, error: 'The SFW rate must be between 0 and 1.' };
  if (!isRate(value.nsfwRate))
    return { ok: false, error: 'The NSFW rate must be between 0 and 1.' };
  return {
    ok: true,
    config: { enabled: value.enabled, sfwRate: value.sfwRate, nsfwRate: value.nsfwRate },
  };
}

const same = (a: KnightsSourcesConfig, b: KnightsSourcesConfig) =>
  a.enabled === b.enabled && a.sfwRate === b.sfwRate && a.nsfwRate === b.nsfwRate;

/**
 * All three fields are written, so a later change to the reader's defaults cannot move a saved rate. A stored
 * `maxOpen` is carried over: the page does not edit it, and dropping it would reset the intake cap to the default.
 */
export async function saveSourcesConfig(input: unknown, moderatorId: number): Promise<SaveOutcome> {
  const checked = validateSourcesInput(input);
  if (!checked.ok) return checked;

  const before = await getSourcesSettings();
  if (before.stored && same(before.config, checked.config)) return { ok: true, changed: false };

  const { maxOpen } = before.config;
  const config: KnightsSourcesConfig = {
    enabled: checked.config.enabled,
    sfwRate: checked.config.sfwRate,
    nsfwRate: checked.config.nsfwRate,
    ...(maxOpen === undefined ? {} : { maxOpen }),
  };
  await getSysRedis().set(REDIS_SYS_KEYS.SYSTEM.KNIGHTS_V2_SOURCES, JSON.stringify(config));
  await recordModActivity({
    userId: moderatorId,
    entityType: SOURCES_AUDIT_ENTITY.type,
    entityId: SOURCES_AUDIT_ENTITY.id,
    activity: `${SOURCES_AUDIT_ACTIVITY} ${JSON.stringify({
      before: before.stored ? before.config : null,
      after: config,
    })}`,
  });
  return { ok: true, changed: true };
}

function parseChange(activity: string): Pick<SourcesChange, 'before' | 'after'> | null {
  if (!activity.startsWith(`${SOURCES_AUDIT_ACTIVITY} `)) return null;
  try {
    const parsed = JSON.parse(activity.slice(SOURCES_AUDIT_ACTIVITY.length + 1)) as {
      before?: unknown;
      after?: unknown;
    };
    const shape = (value: unknown) =>
      value && typeof value === 'object'
        ? readKnightsSourcesConfig(JSON.stringify(value)).config
        : null;
    return { before: shape(parsed.before), after: shape(parsed.after) };
  } catch {
    return null;
  }
}

/** The latest change, read from the primary so a save shows on the reload that follows it. */
export async function getLastSourcesChange(): Promise<SourcesChange | null> {
  const rows = await dbWrite
    .selectFrom('ModActivity')
    .select(['activity', 'createdAt', 'userId'])
    .where('entityType', '=', SOURCES_AUDIT_ENTITY.type)
    .where('entityId', '=', SOURCES_AUDIT_ENTITY.id)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .execute();
  const [row] = await withModerators(rows);
  const change = row ? parseChange(row.activity) : null;
  return row && change
    ? {
        at: row.createdAt,
        moderatorId: row.moderatorId,
        moderatorUsername: row.moderatorUsername,
        ...change,
      }
    : null;
}

export type SourcesContext = {
  openKnightItems: number;
  inquisitorQueue: number;
  last24h: { source: string; count: number }[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Open Knight-stage items ride (status, minRank, ...). The 24 h window has no createdAt index, so it is
 * found through the primary key instead: ids are a serial, so the newest row older than the cutoff bounds
 * the window and only the last day's rows are counted.
 */
export async function getSourcesContext(now = new Date()): Promise<SourcesContext> {
  const cutoff = new Date(now.getTime() - DAY_MS);
  const [open, inquisitorQueue, boundary] = await Promise.all([
    dbRead
      .selectFrom('KnightsQueueItem')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('status', '=', 'Open')
      .where('minRank', '=', 'Knight')
      .executeTakeFirst(),
    countInquisitorQueue(),
    dbRead
      .selectFrom('KnightsQueueItem')
      .select('id')
      .where('createdAt', '<', utc(cutoff))
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst(),
  ]);

  const bySource = await dbRead
    .selectFrom('KnightsQueueItem')
    .select(['source', (eb) => eb.fn.countAll<string>().as('count')])
    .where('id', '>', boundary?.id ?? 0)
    .where('questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
    .groupBy('source')
    .orderBy('source')
    .execute();

  return {
    openKnightItems: Number(open?.count ?? 0),
    inquisitorQueue,
    last24h: bySource.map((r) => ({ source: r.source, count: Number(r.count) })),
  };
}
