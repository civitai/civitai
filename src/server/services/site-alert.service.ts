import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import type {
  EditSiteAlertInput,
  ExtendSiteAlertInput,
  PostSiteAlertInput,
} from '~/server/schema/site-alert.schema';
import { siteAlertWindowError } from '~/server/schema/site-alert.schema';
import { trackModActivity } from '~/server/services/moderator.service';
import { readSiteAlertsVersion } from '~/server/utils/client-config';
import { createTtlMemo } from '~/server/utils/ttl-memoize';
import type {
  SiteAlert,
  SiteAlertActor,
  SiteAlertRecord,
  SiteAlertsPayload,
} from '~/shared/constants/site-alert.constants';
import { SITE_ALERTS_VERSION_FIELD } from '~/shared/constants/site-alert.constants';

const KEY = REDIS_SYS_KEYS.SITE_ALERTS.ALERTS;
// Ended alerts stay listed for moderators this long, then the next write drops them.
const KEEP_ENDED_MS = 7 * 24 * 60 * 60 * 1000;

type Moderator = { id: number; username?: string | null };

function parseRecord(raw: string): SiteAlertRecord | null {
  try {
    return JSON.parse(raw) as SiteAlertRecord;
  } catch {
    return null;
  }
}

function parseRecords(raw: Record<string, string> | null | undefined) {
  return Object.values(raw ?? {})
    .map(parseRecord)
    .filter((x): x is SiteAlertRecord => !!x)
    .sort((a, b) => b.id - a.id);
}

async function readRecords(): Promise<SiteAlertRecord[]> {
  return parseRecords(await withSysReadDeadline(sysRedis.hGetAll(KEY)));
}

/** Picks the public fields, so moderator identities never reach the edge-cached response. */
export function toPublicSiteAlert(record: SiteAlertRecord): SiteAlert {
  return {
    id: record.id,
    severity: record.severity,
    title: record.title,
    message: record.message,
    paths: record.paths,
    surfaces: record.surfaces,
    domains: record.domains,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    dismissible: record.dismissible,
  };
}

// Records and version are read in one MULTI: a save landing between two separate reads could pair
// the new version with the old list, which the edge would then keep under the new version's URL.
const activeSiteAlertsMemo = createTtlMemo(
  async (): Promise<SiteAlertsPayload> => {
    const results = await withSysReadDeadline(
      sysRedis.multi().hGetAll(KEY).hGet(REDIS_SYS_KEYS.CLIENT, SITE_ALERTS_VERSION_FIELD).exec()
    );
    if (!Array.isArray(results) || results.length !== 2)
      throw new Error('site alerts read returned an unexpected reply');
    const [raw, version] = results as unknown as [Record<string, string>, string | null];
    const now = Date.now();
    return {
      version: readSiteAlertsVersion({
        [SITE_ALERTS_VERSION_FIELD]: version ?? undefined,
      }),
      // Not-yet-started alerts are included: nothing writes when one starts, so the browser
      // applies the window itself.
      alerts: parseRecords(raw)
        .filter((x) => new Date(x.endsAt).getTime() > now)
        .map(toPublicSiteAlert),
    };
  },
  5_000,
  () => Date.now()
);

const FORCED_REFRESH_INTERVAL_MS = 1_000;
let lastForcedRefresh = 0;

/**
 * `minVersion` is the version the browser already saw in a header. When this pod's copy is older
 * it re-reads, at most once a second per pod since `minVersion` is caller-supplied.
 */
export async function getActiveSiteAlerts(minVersion = 0) {
  const payload = await activeSiteAlertsMemo();
  if (minVersion <= payload.version) return payload;
  const now = Date.now();
  if (now - lastForcedRefresh < FORCED_REFRESH_INTERVAL_MS) return payload;
  lastForcedRefresh = now;
  activeSiteAlertsMemo.clear();
  return activeSiteAlertsMemo();
}

export function listSiteAlerts() {
  return readRecords();
}

async function getRecord(id: number) {
  const raw = await sysRedis.hGet(KEY, String(id));
  const record = raw ? parseRecord(raw) : null;
  if (!record) throw new TRPCError({ code: 'NOT_FOUND', message: `No site alert ${id}` });
  return record;
}

function actor(moderator: Moderator): SiteAlertActor {
  return {
    id: moderator.id,
    username: moderator.username ?? 'unknown',
    at: new Date().toISOString(),
  };
}

function assertWindow(record: SiteAlertRecord) {
  const error = siteAlertWindowError({
    startsAt: new Date(record.startsAt),
    endsAt: new Date(record.endsAt),
  });
  if (error) throw new TRPCError({ code: 'BAD_REQUEST', message: error });
}

// Writes the record and the next version in one step. The version is max(now, current + 1): a
// timestamp rather than a counter, so if the CLIENT hash is replaced by hand the next save still
// lands above any version a browser has seen; computed inside the script, so two saves at once can
// neither share a version nor move it backwards.
const SAVE_SCRIPT = `
local current = tonumber(redis.call('HGET', KEYS[2], ARGV[3])) or 0
local version = math.max(tonumber(ARGV[4]), current + 1)
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[3], string.format('%d', version))
return string.format('%d', version)
`;

async function save(
  record: SiteAlertRecord,
  moderator: Moderator,
  activity: 'post' | 'edit' | 'extend' | 'end'
) {
  // Everything after this write is best-effort, so a failure there does not invite a retry that
  // posts the alert twice.
  await sysRedis.eval(SAVE_SCRIPT, {
    keys: [KEY, REDIS_SYS_KEYS.CLIENT],
    arguments: [
      String(record.id),
      JSON.stringify(record),
      SITE_ALERTS_VERSION_FIELD,
      String(Date.now()),
    ],
  });
  activeSiteAlertsMemo.clear();

  const logFailure = (step: string) => (error: Error) =>
    logToAxiom({
      name: 'site-alert-save',
      type: 'error',
      message: `${step}: ${error.message}`,
      alertId: record.id,
      activity,
      userId: moderator.id,
    }).catch(() => undefined);

  const cutoff = Date.now() - KEEP_ENDED_MS;
  await readRecords()
    .then((records) => {
      const stale = records.filter((x) => new Date(x.endsAt).getTime() < cutoff);
      if (stale.length)
        return sysRedis.hDel(
          KEY,
          stale.map((x) => String(x.id))
        );
    })
    .catch(logFailure('prune'));
  // Alerts are posted during incidents, which can include the database.
  await trackModActivity(moderator.id, {
    entityType: 'siteAlert',
    activity,
    entityId: record.id,
  }).catch(logFailure('mod-activity'));
  return record;
}

export async function postSiteAlert(input: PostSiteAlertInput, moderator: Moderator) {
  const id = await sysRedis.incr(REDIS_SYS_KEYS.SITE_ALERTS.SEQ);
  const stamp = actor(moderator);
  const record: SiteAlertRecord = {
    id,
    severity: input.severity,
    title: input.title,
    message: input.message ?? null,
    paths: input.paths,
    surfaces: input.surfaces,
    domains: input.domains,
    startsAt: (input.startsAt ?? new Date()).toISOString(),
    endsAt: input.endsAt.toISOString(),
    dismissible: input.dismissible ?? input.severity !== 'outage',
    createdBy: stamp,
    updatedBy: stamp,
  };
  assertWindow(record);
  return save(record, moderator, 'post');
}

export async function editSiteAlert({ id, ...input }: EditSiteAlertInput, moderator: Moderator) {
  const current = await getRecord(id);
  const record: SiteAlertRecord = {
    ...current,
    severity: input.severity ?? current.severity,
    title: input.title ?? current.title,
    message: input.message === undefined ? current.message : input.message,
    paths: input.paths ?? current.paths,
    surfaces: input.surfaces ?? current.surfaces,
    domains: input.domains ?? current.domains,
    startsAt: input.startsAt?.toISOString() ?? current.startsAt,
    endsAt: input.endsAt?.toISOString() ?? current.endsAt,
    dismissible: input.dismissible ?? current.dismissible,
    updatedBy: actor(moderator),
  };
  assertWindow(record);
  return save(record, moderator, 'edit');
}

export async function extendSiteAlert({ id, minutes }: ExtendSiteAlertInput, moderator: Moderator) {
  const current = await getRecord(id);
  const from = Math.max(Date.now(), new Date(current.endsAt).getTime());
  const record: SiteAlertRecord = {
    ...current,
    endsAt: new Date(from + minutes * 60_000).toISOString(),
    updatedBy: actor(moderator),
  };
  assertWindow(record);
  return save(record, moderator, 'extend');
}

export async function endSiteAlert({ id }: { id: number }, moderator: Moderator) {
  const current = await getRecord(id);
  const now = new Date().toISOString();
  const record: SiteAlertRecord = {
    ...current,
    // A scheduled alert ended before it started never shows.
    startsAt: current.startsAt > now ? now : current.startsAt,
    endsAt: now,
    updatedBy: actor(moderator),
  };
  return save(record, moderator, 'end');
}
