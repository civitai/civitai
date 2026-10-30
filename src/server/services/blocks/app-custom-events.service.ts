import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { logToAxiom } from '~/server/logging/client';
import { getOwnedAppBlocks, resolveRange } from '~/server/services/blocks/app-analytics.service';
import {
  APP_BLOCK_EVENTS_TABLE,
  UNDECLARED_EVENT_NAME,
} from '~/server/services/blocks/block-event-table';
import { parseManifestAnalytics } from '~/shared/constants/block-analytics.constants';

/**
 * Owner read of `appBlockEvents`; the table contract (signed-in-only viewers, `viewerKey = 0` for
 * signed-out, `mapContains` gating) is in `2026-10-10-app-block-events.sql`.
 *
 * - Team rows (`isOwner = 1`: the owner or an accepted collaborator was signed in) are excluded
 *   unless asked for, and that exclusion must also cover the `__undeclared__` drop count: the
 *   team's dev-tunnel testing of unpublished events lands there.
 * - Never throws: any failure, including the timeout, degrades to `unavailable` for the whole
 *   section. The queries of one call succeed or fail together (the card lets the owner clear a
 *   selected event whose read keeps failing).
 *
 * Every value rides in `query_params`. The only text built at runtime is chosen from closed sets
 * (an aggregate name, a bucket expression, a property's positional index), never from input.
 */

export const CUSTOM_EVENTS_QUERY_TIMEOUT_SECONDS = 10;

/** One app, one bounded time range; `time` is the partition and sort column. */
export const CUSTOM_EVENTS_WHERE =
  'WHERE appBlockId = {appBlockId:String} AND time >= {from:DateTime64(3)} AND time <= {to:DateTime64(3)}';
export const OWNER_EXCLUSION = ' AND isOwner = 0';

type TimePoint = { bucket: string; value: number };

export type CustomEventPropertyDeclaration =
  | { name: string; type: 'enum'; values: string[] }
  | { name: string; type: 'number' }
  | { name: string; type: 'boolean' };

export type CustomEventDeclaration = {
  name: string;
  description?: string;
  properties: CustomEventPropertyDeclaration[];
};

export type CustomEventTotals = {
  eventName: string;
  count: number;
  /** Distinct signed-in viewers. */
  signedInViewers: number;
  /** Events from signed-out viewers: an event count, not a viewer count. */
  anonymousEvents: number;
};

export type CustomEventPropertyBreakdown =
  | { name: string; type: 'enum'; values: Array<{ value: string; count: number }> }
  | {
      name: string;
      type: 'number';
      /** Events that carried the property; the other statistics cover only these. */
      count: number;
      sum: number;
      avg: number | null;
      p50: number | null;
      p95: number | null;
    }
  | { name: string; type: 'boolean'; trueCount: number; falseCount: number };

export type AppCustomEvents = {
  /** What the app's manifest declares, so declared-but-unsent events still show. */
  declared: CustomEventDeclaration[];
  /** Team rows (`isOwner = 1`: owner or accepted collaborator) are included. */
  includeOwner: boolean;
  /** One row per declared event, zeros included, most-sent first. */
  topEvents: CustomEventTotals[];
  /** Rows stored as `__undeclared__`: sent under a name the approved manifest does not declare. */
  undeclaredDrops: number;
  /** Present only when the requested event is declared. */
  selected?: {
    eventName: string;
    series: TimePoint[];
    properties: CustomEventPropertyBreakdown[];
  };
  /** The zeros are a placeholder: ClickHouse is unconfigured, failed or timed out. */
  unavailable?: boolean;
};

export function declaredCustomEvents(manifest: unknown): CustomEventDeclaration[] {
  const { events } = parseManifestAnalytics(manifest);
  return [...events].map(([name, event]) => ({
    name,
    ...(event.description !== undefined ? { description: event.description } : {}),
    properties: [...event.properties].map(([propName, prop]) =>
      prop.type === 'enum'
        ? { name: propName, type: 'enum' as const, values: [...prop.values] }
        : { name: propName, type: prop.type }
    ),
  }));
}

function unavailableCustomEvents(
  declared: CustomEventDeclaration[],
  includeOwner: boolean
): AppCustomEvents {
  return { declared, includeOwner, topEvents: [], undeclaredDrops: 0, unavailable: true };
}

/** `Date` and week buckets both arrive as `YYYY-MM-DD`; emit the ISO form the Postgres series use. */
function bucketToIso(bucket: string): string {
  return new Date(`${bucket}T00:00:00.000Z`).toISOString();
}

/** ClickHouse renders NaN (an aggregate over no rows) as JSON `null`. */
function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

type TopRow = {
  eventName: string;
  events: number | string;
  signedInViewers: number | string;
  anonymousEvents: number | string;
};
type SeriesRow = { bucket: string; value: number | string };
type EnumRow = { property: string; value: string; events: number | string };

export async function getAppCustomEvents({
  appBlockId,
  manifest,
  range,
  includeOwner = false,
  event,
  ch = clickhouse,
}: {
  appBlockId: string;
  manifest: unknown;
  range: { from: Date; to: Date; granularity: 'day' | 'week' };
  includeOwner?: boolean;
  event?: string;
  ch?: typeof clickhouse;
}): Promise<AppCustomEvents> {
  const declared = declaredCustomEvents(manifest);
  if (!ch) return unavailableCustomEvents(declared, includeOwner);

  const where = CUSTOM_EVENTS_WHERE + (includeOwner ? '' : OWNER_EXCLUSION);
  const bucketExpr =
    range.granularity === 'week' ? "toStartOfWeek(time, 1, 'UTC')" : "toDate(time, 'UTC')";
  const selected = event ? declared.find((d) => d.name === event) : undefined;
  const numberProps = selected?.properties.filter((p) => p.type === 'number') ?? [];
  const booleanProps = selected?.properties.filter((p) => p.type === 'boolean') ?? [];
  const enumProps = (selected?.properties.filter((p) => p.type === 'enum') ?? []) as Array<
    Extract<CustomEventPropertyDeclaration, { type: 'enum' }>
  >;

  const baseParams = {
    appBlockId,
    from: formatClickhouseDateTime64(range.from),
    to: formatClickhouseDateTime64(range.to),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CUSTOM_EVENTS_QUERY_TIMEOUT_SECONDS * 1000);
  const run = async <T>(query: string, params: Record<string, unknown>): Promise<T[]> => {
    const resp = await ch.query({
      query,
      query_params: { ...baseParams, ...params },
      format: 'JSONEachRow',
      abort_signal: controller.signal,
      clickhouse_settings: { max_execution_time: CUSTOM_EVENTS_QUERY_TIMEOUT_SECONDS },
    });
    return (await resp.json()) as T[];
  };

  try {
    const topQuery = run<TopRow>(
      `SELECT eventName, count() AS events, uniqExactIf(viewerKey, viewerKey != 0) AS signedInViewers, countIf(viewerKey = 0) AS anonymousEvents FROM ${APP_BLOCK_EVENTS_TABLE} ${where} AND eventName IN {eventNames:Array(String)} GROUP BY eventName LIMIT 100`,
      { eventNames: [...declared.map((d) => d.name), UNDECLARED_EVENT_NAME] }
    );

    const seriesQuery = selected
      ? run<SeriesRow>(
          `SELECT ${bucketExpr} AS bucket, count() AS value FROM ${APP_BLOCK_EVENTS_TABLE} ${where} AND eventName = {event:String} GROUP BY bucket ORDER BY bucket LIMIT 400`,
          { event: selected.name }
        )
      : Promise.resolve([]);

    // An absent Map key reads as 0, so every aggregate gates on `mapContains`; without it an
    // event that omits the property would count as a 0 / `false`.
    const scalarColumns = [
      ...numberProps.map(
        (_, i) =>
          `countIf(mapContains(numProps, {n${i}:String})) AS n${i}_count, ` +
          `sumIf(numProps[{n${i}:String}], mapContains(numProps, {n${i}:String})) AS n${i}_sum, ` +
          `avgIf(numProps[{n${i}:String}], mapContains(numProps, {n${i}:String})) AS n${i}_avg, ` +
          `quantilesTDigestIf(0.5, 0.95)(numProps[{n${i}:String}], mapContains(numProps, {n${i}:String})) AS n${i}_q`
      ),
      ...booleanProps.map(
        (_, i) =>
          `countIf(mapContains(boolProps, {b${i}:String}) AND boolProps[{b${i}:String}] = 1) AS b${i}_true, ` +
          `countIf(mapContains(boolProps, {b${i}:String}) AND boolProps[{b${i}:String}] = 0) AS b${i}_false`
      ),
    ];
    const scalarQuery =
      selected && scalarColumns.length > 0
        ? run<Record<string, unknown>>(
            `SELECT ${scalarColumns.join(
              ', '
            )} FROM ${APP_BLOCK_EVENTS_TABLE} ${where} AND eventName = {event:String}`,
            {
              event: selected.name,
              ...Object.fromEntries(numberProps.map((p, i) => [`n${i}`, p.name])),
              ...Object.fromEntries(booleanProps.map((p, i) => [`b${i}`, p.name])),
            }
          )
        : Promise.resolve([]);

    const enumQuery =
      selected && enumProps.length > 0
        ? run<EnumRow>(
            `SELECT property, value, count() AS events FROM ${APP_BLOCK_EVENTS_TABLE} ARRAY JOIN mapKeys(enumProps) AS property, mapValues(enumProps) AS value ${where} AND eventName = {event:String} AND property IN {enumNames:Array(String)} GROUP BY property, value LIMIT 1000`,
            { event: selected.name, enumNames: enumProps.map((p) => p.name) }
          )
        : Promise.resolve([]);

    const [topRows, seriesRows, scalarRows, enumRows] = await Promise.all([
      topQuery,
      seriesQuery,
      scalarQuery,
      enumQuery,
    ]);

    const byName = new Map(topRows.map((r) => [r.eventName, r]));
    const topEvents = declared
      .map((d): CustomEventTotals => {
        const row = byName.get(d.name);
        return {
          eventName: d.name,
          count: Number(row?.events ?? 0),
          signedInViewers: Number(row?.signedInViewers ?? 0),
          anonymousEvents: Number(row?.anonymousEvents ?? 0),
        };
      })
      .sort((a, b) => b.count - a.count);

    const result: AppCustomEvents = {
      declared,
      includeOwner,
      topEvents,
      undeclaredDrops: Number(byName.get(UNDECLARED_EVENT_NAME)?.events ?? 0),
    };

    if (selected) {
      const scalar = scalarRows[0] ?? {};
      const enumCounts = new Map(enumRows.map((r) => [`${r.property}\u0000${r.value}`, r.events]));
      const numberIndex = new Map(numberProps.map((p, i) => [p.name, i]));
      const booleanIndex = new Map(booleanProps.map((p, i) => [p.name, i]));
      result.selected = {
        eventName: selected.name,
        series: seriesRows.map((r) => ({ bucket: bucketToIso(r.bucket), value: Number(r.value) })),
        properties: selected.properties.map((p): CustomEventPropertyBreakdown => {
          if (p.type === 'enum') {
            return {
              name: p.name,
              type: 'enum',
              values: p.values.map((value) => ({
                value,
                count: Number(enumCounts.get(`${p.name}\u0000${value}`) ?? 0),
              })),
            };
          }
          if (p.type === 'number') {
            const i = numberIndex.get(p.name);
            const count = Number(scalar[`n${i}_count`] ?? 0);
            const q = Array.isArray(scalar[`n${i}_q`]) ? (scalar[`n${i}_q`] as unknown[]) : [];
            return {
              name: p.name,
              type: 'number',
              count,
              sum: count > 0 ? Number(scalar[`n${i}_sum`] ?? 0) : 0,
              avg: count > 0 ? finiteOrNull(scalar[`n${i}_avg`]) : null,
              p50: count > 0 ? finiteOrNull(q[0]) : null,
              p95: count > 0 ? finiteOrNull(q[1]) : null,
            };
          }
          const i = booleanIndex.get(p.name);
          return {
            name: p.name,
            type: 'boolean',
            trueCount: Number(scalar[`b${i}_true`] ?? 0),
            falseCount: Number(scalar[`b${i}_false`] ?? 0),
          };
        }),
      };
    }
    return result;
  } catch (error) {
    logToAxiom(
      {
        name: 'app-custom-events-service',
        type: 'error',
        message: 'appBlockEvents read failed',
        error: (error as Error)?.message,
      },
      'clickhouse'
    ).catch(() => undefined);
    return unavailableCustomEvents(declared, includeOwner);
  } finally {
    clearTimeout(timer);
    // One failed query must not leave the others running.
    controller.abort();
  }
}

export type CustomEventsRange = { from: Date; to: Date; granularity: 'day' | 'week' };

export type MyAppCustomEvents = AppCustomEvents & {
  /** The resolved range, the same one `getMyAppAnalytics` uses. */
  range: CustomEventsRange;
  /** Set when nothing was queried: the flag is off, or the caller cannot see this app. */
  denied?: 'notEntitled' | 'notOwned';
};

export function deniedCustomEvents(
  range: CustomEventsRange,
  denied: 'notEntitled' | 'notOwned'
): MyAppCustomEvents {
  return { ...unavailableCustomEvents([], false), range, denied };
}

/**
 * The Custom events section for ONE app the caller can see. Ownership is resolved first, by the
 * same `getOwnedAppBlocks` `getMyAppAnalytics` uses, and fails closed before any ClickHouse read.
 */
export async function getMyAppCustomEvents({
  userId,
  appBlockId,
  from,
  to,
  now,
  includeOwner = false,
  event,
  ch,
}: {
  userId: number;
  appBlockId: string;
  from?: Date;
  to?: Date;
  now?: Date;
  includeOwner?: boolean;
  event?: string;
  ch?: typeof clickhouse;
}): Promise<MyAppCustomEvents> {
  const range = resolveRange({ from, to, now });
  const [app] = await getOwnedAppBlocks({ ownerUserId: userId, appBlockId });
  if (!app) return deniedCustomEvents(range, 'notOwned');
  const section = await getAppCustomEvents({
    appBlockId: app.id,
    manifest: app.manifest,
    range,
    includeOwner,
    event,
    ...(ch !== undefined ? { ch } : {}),
  });
  return { ...section, range };
}
