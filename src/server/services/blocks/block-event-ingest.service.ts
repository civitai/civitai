import type { NextApiRequest, NextApiResponse } from 'next';
import { CACHE_KEY_NAMESPACE } from '@civitai/redis';
import { isPreview } from '~/env/other';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { logToAxiom } from '~/server/logging/client';
import { recordBlockCustomEvents } from '~/server/metrics/app-block-runtime.metrics';
import type { BlockEventBatchInput } from '~/server/schema/track.schema';
import type { SessionUser } from '~/types/session';
import { blockEventRateLimiter } from '~/server/services/blocks/block-event-rate-limit';
import {
  ANONYMOUS_VIEWER_KEY,
  rateLimitAddressKey,
  signedInViewerKey,
} from '~/server/services/blocks/block-event-viewer-key';
import {
  getApprovedAppBlockAnalytics,
  type ApprovedAppBlockAnalytics,
  type ApprovedEventDeclarations,
} from '~/server/services/blocks/known-app-blocks.service';
import { isPrivateRunImpression } from '~/server/services/blocks/private-run-impression.service';
import { getEdgeAttestedClientIp } from '~/server/utils/client-ip';

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
  /** UInt64 as a decimal string; `'0'` for a signed-out viewer. See `block-event-viewer-key.ts`. */
  viewerKey: string;
  isAnon: 0 | 1;
  isOwner: 0 | 1;
  enumProps: Record<string, string>;
  numProps: Record<string, number>;
  boolProps: Record<string, 0 | 1>;
};

/**
 * A block instance id is stored only when it is shaped like a platform id; anything else is
 * stored empty. A page instance id must be exactly the page id of the row's own app. The other
 * kinds are shape-checked only, so within that shape the value is still the caller's.
 */
const BLOCK_INSTANCE_ID_RE = /^(?:mbi|bki|bus_pub|bus_view|pdb)_[A-Za-z0-9_]{1,100}$/;

function isStorableInstanceId(blockInstanceId: string, appBlockId: string): boolean {
  if (blockInstanceId.startsWith('page_')) return blockInstanceId === `page_${appBlockId}`;
  return BLOCK_INSTANCE_ID_RE.test(blockInstanceId);
}

/** A write still unanswered after this long is abandoned. */
export const BLOCK_EVENT_INSERT_TIMEOUT_MS = 5_000;
/**
 * Most writes in flight per process; past it new batches are dropped (`insert_failed`). With the
 * timeout above this bounds the sockets and rows a stalled ClickHouse can pin in a web process.
 */
export const BLOCK_EVENT_MAX_INFLIGHT_INSERTS = 32;
let inflightInserts = 0;

/** The environment variable a deployment sets to `production` to be allowed to write. */
export const DEPLOYMENT_ENVIRONMENT_VAR = 'CIVITAI_DEPLOYMENT_ENVIRONMENT';

/**
 * Whether this process may write. Non-production deployments may share the same ClickHouse, and
 * a row written from one is indistinguishable from a real one.
 *
 * FAILS CLOSED: a write needs the deployment to say, by exact value, that it is production. An
 * absent, empty or unrecognised value skips the write, so a deployment nobody configured cannot
 * write. `IS_PREVIEW` and a non-empty cache-key namespace still veto it, so a non-production
 * deployment that inherits the variable by copying another's environment does not write either.
 */
export function isProductionDeployment(
  signals: {
    deploymentEnvironment: string | undefined;
    isPreview: boolean;
    cacheKeyNamespace: string;
  } = {
    deploymentEnvironment: process.env[DEPLOYMENT_ENVIRONMENT_VAR],
    isPreview,
    cacheKeyNamespace: CACHE_KEY_NAMESPACE,
  }
): boolean {
  return (
    signals.deploymentEnvironment === 'production' &&
    !signals.isPreview &&
    signals.cacheKeyNamespace === ''
  );
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
 * when the insert does, never rejects, and is not awaited on the request path.
 *
 * `time` is the server's clock. A client timestamp is not accepted at all: the table partitions
 * and expires on `time`, so a caller-chosen value could place a row in any partition or past the
 * retention window.
 */
export async function ingestBlockEvents(args: {
  events: IncomingEvent[];
  req: NextApiRequest;
  res: NextApiResponse;
  nowMs?: number;
}): Promise<{ written: Promise<void> }> {
  const { events, req, res, nowMs = Date.now() } = args;
  const done = { written: Promise.resolve() };
  // The client address keys ONLY the in-memory budget; it never reaches a row. Client addresses
  // cannot be trusted enough to identify viewers, so this is a cost control, not an identity.
  // Without the edge's attestation a request shares one fallback budget rather than taking the
  // transport peer, which behind a reverse proxy is the proxy.
  const clientIp = getEdgeAttestedClientIp(req);
  const budgetKey = clientIp ? rateLimitAddressKey(clientIp) : 'unattested';

  // Cheapest gates first, and both before the session is resolved: once the approved set is
  // cached an unknown app costs a Map lookup, and an over-budget caller costs arithmetic. The
  // limiter is keyed only on apps that passed the approved check, so a caller cannot grow it by
  // inventing app ids.
  const byApp = new Map<string, IncomingEvent[]>();
  for (const event of events) {
    const group = byApp.get(event.appBlockId);
    if (group) group.push(event);
    else byApp.set(event.appBlockId, [event]);
  }
  const limiter = blockEventRateLimiter();
  const admitted: Array<{ analytics: ApprovedAppBlockAnalytics; events: IncomingEvent[] }> = [];
  let admittedRows = 0;
  for (const [appBlockId, group] of byApp) {
    const analytics = await getApprovedAppBlockAnalytics(appBlockId);
    if (!analytics) {
      recordBlockCustomEvents('unknown_app', group.length);
      continue;
    }
    if (!clientIp) recordBlockCustomEvents('unattested_address', group.length);
    const granted = limiter.take(`${budgetKey} ${appBlockId}`, group.length, nowMs);
    recordBlockCustomEvents('rate_limited', group.length - granted);
    if (granted > 0) {
      admitted.push({ analytics, events: group.slice(0, granted) });
      admittedRows += granted;
    }
  }
  if (admitted.length === 0) return done;

  // Identity comes from the session, never from the body.
  let viewer: SessionUser | undefined;
  try {
    viewer = (await getServerAuthSession({ req, res }))?.user;
  } catch {
    // Not written as signed-out: that would file a signed-in viewer's events under another key.
    recordBlockCustomEvents('session_failed', admittedRows);
    return done;
  }
  const signedIn = !!viewer && typeof viewer.id === 'number';

  // A signed-out viewer is not keyed: unique viewers are counted for signed-in viewers only.
  const viewerKey = viewer && signedIn ? signedInViewerKey(viewer.id) : ANONYMOUS_VIEWER_KEY;

  const rows: AppBlockEventRow[] = [];
  const counts = { accepted: 0, undeclared: 0, undeclaredProp: 0, invalidValue: 0, badInstance: 0 };
  for (const { analytics, events: group } of admitted) {
    const appBlockId = group[0].appBlockId;
    // The predicate the impression writers use. A private run is of an app that is not approved,
    // and those rows were already dropped above; this covers an app that left the approved set
    // while the ingest's cached copy of that set still lists it. For an app both caches agree is
    // approved it is a cached lookup, so a caller cannot use it to cause database work.
    if (await isPrivateRunImpression({ appBlockId, viewer })) {
      recordBlockCustomEvents('private_run', group.length);
      continue;
    }
    const isOwner =
      !!viewer && signedIn && analytics.ownerUserId !== null && viewer.id === analytics.ownerUserId;
    for (const event of group) {
      const classified = classifyBlockEvent(analytics.events, event.eventName, event.properties);
      if (classified.declared) counts.accepted += 1;
      else counts.undeclared += 1;
      if (classified.undeclaredProp) counts.undeclaredProp += 1;
      if (classified.invalidValue) counts.invalidValue += 1;
      const instanceIdOk = isStorableInstanceId(event.blockInstanceId, appBlockId);
      if (!instanceIdOk) counts.badInstance += 1;
      rows.push(
        buildAppBlockEventRow({
          nowMs,
          appBlockId,
          blockInstanceId: instanceIdOk ? event.blockInstanceId : '',
          classified,
          userId: viewer && signedIn ? viewer.id : null,
          viewerKey,
          isOwner,
        })
      );
    }
  }
  recordBlockCustomEvents('undeclared_prop', counts.undeclaredProp);
  recordBlockCustomEvents('invalid_value', counts.invalidValue);
  recordBlockCustomEvents('invalid_instance_id', counts.badInstance);
  if (rows.length === 0) return done;

  if (!isProductionDeployment()) {
    recordBlockCustomEvents('non_prod_skipped', rows.length);
    return done;
  }
  const client = clickhouse;
  if (!client || inflightInserts >= BLOCK_EVENT_MAX_INFLIGHT_INSERTS) {
    recordBlockCustomEvents('insert_failed', rows.length);
    return done;
  }

  inflightInserts += 1;
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), BLOCK_EVENT_INSERT_TIMEOUT_MS);
  const written = Promise.resolve()
    .then(() =>
      client.insert({
        table: APP_BLOCK_EVENTS_TABLE,
        values: rows,
        format: 'JSONEachRow',
        abort_signal: deadline.signal,
      })
    )
    .then(
      () => {
        recordBlockCustomEvents('accepted', counts.accepted);
        recordBlockCustomEvents('undeclared_event', counts.undeclared);
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
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(deadlineTimer);
      inflightInserts -= 1;
    });
  return { written };
}
