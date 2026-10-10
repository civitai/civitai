import type { NextApiRequest, NextApiResponse } from 'next';
import { CACHE_KEY_NAMESPACE } from '@civitai/redis';
import { isPreview } from '~/env/other';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { logToAxiom } from '~/server/logging/client';
import { recordBlockCustomEvents } from '~/server/metrics/app-block-runtime.metrics';
import type { BlockEventBatchInput } from '~/server/schema/track.schema';
import { getBlockEventDaySalt } from '~/server/services/blocks/block-event-day-salt';
import { blockEventRateLimiter } from '~/server/services/blocks/block-event-rate-limit';
import {
  normalizeViewerIp,
  signedInViewerKey,
  signedOutViewerKey,
} from '~/server/services/blocks/block-event-viewer-key';
import {
  getApprovedAppBlockAnalytics,
  type ApprovedAppBlockAnalytics,
  type ApprovedEventDeclarations,
} from '~/server/services/blocks/known-app-blocks.service';
import { isPrivateRunImpression } from '~/server/services/blocks/private-run-impression.service';
import { resolveClientIp } from '~/server/utils/client-ip';

export const APP_BLOCK_EVENTS_TABLE = 'appBlockEvents';

/**
 * Stored in place of an event name the approved manifest does not declare, so the owner sees a
 * drop count while the caller-chosen name is never written. Declared names cannot collide with
 * it: they must start with a letter.
 */
export const UNDECLARED_EVENT_NAME = '__undeclared__';

/** One `appBlockEvents` row, in JSONEachRow shape. Pinned to the DDL by a parity test. */
export type AppBlockEventRow = {
  time: string;
  appBlockId: string;
  blockInstanceId: string;
  eventName: string;
  userId: number;
  /** UInt64 as a decimal string; see `block-event-viewer-key.ts`. */
  viewerKey: string;
  isAnon: 0 | 1;
  isOwner: 0 | 1;
  enumProps: Record<string, string>;
  numProps: Record<string, number>;
  boolProps: Record<string, 0 | 1>;
};

/**
 * Whether this process is the production deployment, which is the only one allowed to write.
 * Non-production deployments can be configured with the production ClickHouse, and a row written
 * from one is indistinguishable from a real one.
 *
 * Neither existing signal is enough alone, so both must agree: `IS_PREVIEW` is not set on every
 * non-production deployment, and the cache-key namespace is empty only on production by that
 * module's own contract. A deployment that sets neither is taken for production.
 */
export function isProductionDeployment(
  signals: { isPreview: boolean; cacheKeyNamespace: string } = {
    isPreview,
    cacheKeyNamespace: CACHE_KEY_NAMESPACE,
  }
): boolean {
  return !signals.isPreview && signals.cacheKeyNamespace === '';
}

export type ClassifiedEvent = Pick<
  AppBlockEventRow,
  'eventName' | 'enumProps' | 'numProps' | 'boolProps'
> & {
  declared: boolean;
  /** At least one property the event does not declare was sent (and not stored). */
  undeclaredProp: boolean;
  /** At least one declared property was dropped for a wrong type or an undeclared enum value. */
  invalidValue: boolean;
};

/**
 * Reduce one client event to what the approved manifest declares. Nothing the caller chose is
 * stored unless the manifest names it: not the event name, not a property name, not a string.
 */
export function classifyBlockEvent(
  declarations: ApprovedEventDeclarations,
  eventName: unknown,
  properties: unknown
): ClassifiedEvent {
  const enumProps: Record<string, string> = {};
  const numProps: Record<string, number> = {};
  const boolProps: Record<string, 0 | 1> = {};
  const declaredProperties =
    typeof eventName === 'string' ? declarations.get(eventName) : undefined;
  if (typeof eventName !== 'string' || !declaredProperties) {
    return {
      eventName: UNDECLARED_EVENT_NAME,
      enumProps,
      numProps,
      boolProps,
      declared: false,
      undeclaredProp: false,
      invalidValue: false,
    };
  }

  const sent: Record<string, unknown> =
    typeof properties === 'object' && properties !== null && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)
      : {};
  let matched = 0;
  let invalidValue = false;
  // Driven by the DECLARED names (at most 10), never by what was sent, and through an own-property
  // check: `constructor` is a legal declared name and every object inherits one.
  for (const [name, declaration] of declaredProperties) {
    if (!Object.prototype.hasOwnProperty.call(sent, name)) continue;
    matched += 1;
    const value = sent[name];
    if (declaration.type === 'enum') {
      if (typeof value === 'string' && declaration.values.has(value)) enumProps[name] = value;
      else invalidValue = true;
    } else if (declaration.type === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) numProps[name] = value;
      else invalidValue = true;
    } else if (typeof value === 'boolean') {
      boolProps[name] = value ? 1 : 0;
    } else {
      invalidValue = true;
    }
  }

  return {
    eventName,
    enumProps,
    numProps,
    boolProps,
    declared: true,
    undeclaredProp: Object.keys(sent).length > matched,
    invalidValue,
  };
}

/** The one place a row is assembled, so the DDL parity test pins what is actually inserted. */
export function buildAppBlockEventRow(args: {
  nowMs: number;
  appBlockId: string;
  blockInstanceId: string;
  classified: Pick<ClassifiedEvent, 'eventName' | 'enumProps' | 'numProps' | 'boolProps'>;
  /** `null` for a signed-out viewer. */
  userId: number | null;
  viewerKey: string;
  isOwner: boolean;
}): AppBlockEventRow {
  return {
    time: formatClickhouseDateTime64(args.nowMs),
    appBlockId: args.appBlockId,
    blockInstanceId: args.blockInstanceId,
    eventName: args.classified.eventName,
    userId: args.userId ?? 0,
    viewerKey: args.viewerKey,
    isAnon: args.userId === null ? 1 : 0,
    isOwner: args.isOwner ? 1 : 0,
    enumProps: args.classified.enumProps,
    numProps: args.classified.numProps,
    boolProps: args.classified.boolProps,
  };
}

type IncomingEvent = BlockEventBatchInput['events'][number];

/**
 * Validate a batch and write what survives. Resolves once validation is done; `written` settles
 * when the insert does, and nothing awaits it on the request path.
 *
 * `time` is the server's clock. A client timestamp is not accepted at all: the table partitions
 * and expires on `time`, so a caller-chosen value could place a row in any partition or past the
 * retention window, and a batch is at most a few seconds old when it arrives.
 */
export async function ingestBlockEvents(args: {
  events: IncomingEvent[];
  req: NextApiRequest;
  res: NextApiResponse;
  nowMs?: number;
}): Promise<{ written: Promise<void> }> {
  const { events, req, res, nowMs = Date.now() } = args;
  const done = { written: Promise.resolve() };
  const clientIp = resolveClientIp(req);

  // Cheapest gates first, and both before the session is resolved: an unknown app costs a Map
  // lookup and an over-budget caller costs arithmetic. The limiter is keyed only on apps that
  // passed the approved check, so a caller cannot grow it by inventing app ids.
  const byApp = new Map<string, IncomingEvent[]>();
  for (const event of events) {
    const group = byApp.get(event.appBlockId);
    if (group) group.push(event);
    else byApp.set(event.appBlockId, [event]);
  }
  const limiter = blockEventRateLimiter();
  const admitted: Array<{ analytics: ApprovedAppBlockAnalytics; events: IncomingEvent[] }> = [];
  for (const [appBlockId, group] of byApp) {
    const analytics = await getApprovedAppBlockAnalytics(appBlockId);
    if (!analytics) {
      recordBlockCustomEvents('unknown_app', group.length);
      continue;
    }
    const granted = limiter.take(`${clientIp} ${appBlockId}`, group.length, nowMs);
    recordBlockCustomEvents('rate_limited', group.length - granted);
    if (granted > 0) admitted.push({ analytics, events: group.slice(0, granted) });
  }
  if (admitted.length === 0) return done;

  // Identity comes from the session and the connection, never from the body.
  const session = await getServerAuthSession({ req, res });
  const viewer = session?.user;
  const signedIn = !!viewer && typeof viewer.id === 'number';

  let viewerKey: string;
  if (signedIn) {
    viewerKey = signedInViewerKey(viewer.id);
  } else {
    const remaining = admitted.reduce((sum, group) => sum + group.events.length, 0);
    const ip = normalizeViewerIp(clientIp);
    if (!ip) {
      recordBlockCustomEvents('no_client_ip', remaining);
      return done;
    }
    const salt = await getBlockEventDaySalt(nowMs);
    if (!salt) {
      // Dropped, not stored under a placeholder key: the salt contract forbids a local fallback,
      // and a shared placeholder would read as one very active viewer.
      recordBlockCustomEvents('salt_unavailable', remaining);
      return done;
    }
    viewerKey = signedOutViewerKey(salt, ip);
  }

  const rows: AppBlockEventRow[] = [];
  let acceptedRows = 0;
  let undeclaredRows = 0;
  for (const { analytics, events: group } of admitted) {
    const appBlockId = group[0].appBlockId;
    // The same server-derived predicate the impression writers use, so a private run of an app
    // stays out of every owner-visible table. Only reachable for an app this process still
    // believes is approved, so it costs a cached lookup and nothing a caller can amplify.
    if (await isPrivateRunImpression({ appBlockId, viewer })) {
      recordBlockCustomEvents('private_run', group.length);
      continue;
    }
    const isOwner =
      signedIn && analytics.ownerUserId !== null && viewer.id === analytics.ownerUserId;
    for (const event of group) {
      const classified = classifyBlockEvent(analytics.events, event.eventName, event.properties);
      if (classified.declared) acceptedRows += 1;
      else undeclaredRows += 1;
      if (classified.undeclaredProp) recordBlockCustomEvents('undeclared_prop');
      if (classified.invalidValue) recordBlockCustomEvents('invalid_value');
      rows.push(
        buildAppBlockEventRow({
          nowMs,
          appBlockId,
          blockInstanceId: event.blockInstanceId,
          classified,
          userId: signedIn ? viewer.id : null,
          viewerKey,
          isOwner,
        })
      );
    }
  }
  if (rows.length === 0) return done;

  if (!isProductionDeployment()) {
    recordBlockCustomEvents('non_prod_skipped', rows.length);
    return done;
  }
  const client = clickhouse;
  if (!client) {
    recordBlockCustomEvents('insert_failed', rows.length);
    return done;
  }

  const written = Promise.resolve()
    .then(() =>
      client.insert({ table: APP_BLOCK_EVENTS_TABLE, values: rows, format: 'JSONEachRow' })
    )
    .then(
      () => {
        recordBlockCustomEvents('accepted', acceptedRows);
        recordBlockCustomEvents('undeclared_event', undeclaredRows);
      },
      (error: unknown) => {
        recordBlockCustomEvents('insert_failed', rows.length);
        // The error NAME only: a ClickHouse parse error can quote the row it rejected.
        return logToAxiom(
          {
            name: 'app-block-events-insert-failed',
            type: 'error',
            rows: rows.length,
            error: error instanceof Error ? error.name : typeof error,
          },
          'clickhouse'
        ).then(() => undefined);
      }
    )
    // Nothing awaits `written` on the request path, so it must never reject.
    .catch(() => undefined);
  return { written };
}
