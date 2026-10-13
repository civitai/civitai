import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import semver from 'semver';
import { dbWrite } from '~/server/db/client';
import type {
  CreatePlatformFeedbackInput,
  GetPlatformFeedbackStatusInput,
  PlatformFeedbackClient,
  PlatformFeedbackReadbackStatus,
  PlatformFeedbackReport,
  PlatformFeedbackServerState,
} from '~/server/schema/platform-feedback.schema';
import { platformFeedbackServerStateSchema } from '~/server/schema/platform-feedback.schema';
import {
  FEEDBACK_AREA_DISABLED_MESSAGE,
  isFeedbackAreaEnabled,
} from '~/server/services/feedback.service';
import { APPS_PLATFORM_FEEDBACK_AREA } from '~/shared/constants/feedback.constants';
import type { SessionUser } from '~/types/session';

/**
 * Developer-platform feedback (`Feedback.area = 'apps-platform'`), sent by coding agents with an
 * API token. One row per fingerprint: a repeat of a known report is counted on the existing row
 * instead of stored again, and the sender gets back a ref it can later ask the status of.
 *
 * The stored context is `{ report, server }`. `report` is the parsed client input; `server` is
 * composed here and never read from the client.
 */

export const PLATFORM_FEEDBACK_REPORTER_IDS_MAX = 50;
export const PLATFORM_FEEDBACK_SAMPLES_MAX = 5;
export const PLATFORM_FEEDBACK_SAMPLE_TEXT_MAX_LENGTH = 300;
const PUBLIC_NOTE_MAX_LENGTH = 300;
const REF_SUFFIX_LENGTH = 8;
const LOCK_TIMEOUT = '3s';
const INT4_MAX = 2_147_483_647;

/**
 * Which `resolution.fixedIn.component` a reporting client's own version can be compared against.
 * `other` is absent on purpose: its version says nothing about any component we ship.
 */
export const PLATFORM_FEEDBACK_CLIENT_COMPONENT: Partial<Record<PlatformFeedbackClient, string>> = {
  'civitai-cli': 'cli',
  'civitai-mcp': 'mcp',
};

const normalizeMessage = (message: string) =>
  message.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Reports naming a failure site (`report.ref`) share one row across every user. Free-text reports
 * have no such key, so they only collapse a user's own repeats.
 */
export function platformFeedbackFingerprint({
  userId,
  message,
  report,
}: {
  userId: number;
  message: string;
  report: Pick<PlatformFeedbackReport, 'about' | 'ref'>;
}) {
  const basis = report.ref
    ? `v1\n${report.about}\n${report.ref}`
    : `v1\nu${userId}\n${report.about}\n${normalizeMessage(message)}`;
  return createHash('sha256').update(basis).digest('hex');
}

const toRef = (id: number, fingerprint: string) =>
  `${id}-${fingerprint.slice(0, REF_SUFFIX_LENGTH)}`;

const REF_PATTERN = /^([1-9]\d{0,9})-[0-9a-f]{8}$/;

function parseRef(ref: string) {
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;
  const id = Number(match[1]);
  return id <= INT4_MAX ? { id } : null;
}

/** `1.4`, `v1.4.0` and `1.4.0-rc.1+build` parse; anything else is null. */
function parseVersion(version: string) {
  const padded = /^v?\d+(\.\d+)?$/.test(version)
    ? `${version}${version.includes('.') ? '.0' : '.0.0'}`
    : version;
  return semver.valid(padded);
}

/**
 * Has this reporter already got the fix? Only then is a repeat of a fixed report a regression.
 * A version that does not parse counts as not having it, so it never opens a regression row.
 */
function hasFix(report: PlatformFeedbackReport, state: PlatformFeedbackServerState) {
  const fixedIn = state.resolution?.fixedIn;
  if (!fixedIn || fixedIn.component !== PLATFORM_FEEDBACK_CLIENT_COMPONENT[report.client.name])
    return false;
  const reported = parseVersion(report.client.version);
  const fixed = parseVersion(fixedIn.version);
  return !!reported && !!fixed && semver.gte(reported, fixed);
}

const parseServerState = (server: unknown) =>
  platformFeedbackServerStateSchema.parse(
    server && typeof server === 'object' && !Array.isArray(server) ? server : {}
  );

function readbackStatus(status: string, hasFixedVersion: boolean): PlatformFeedbackReadbackStatus {
  switch (status) {
    case 'reviewed':
      return 'acknowledged';
    case 'actioned':
      return hasFixedVersion ? 'fixed' : 'addressed';
    case 'dismissed':
      return 'not_planned';
    default:
      return 'received';
  }
}

function toReadback(status: string, state: PlatformFeedbackServerState) {
  const fixedIn = state.resolution?.fixedIn ?? null;
  const note = state.resolution?.publicNote?.slice(0, PUBLIC_NOTE_MAX_LENGTH) ?? null;
  return {
    status: readbackStatus(status, !!fixedIn?.version),
    fixedIn: fixedIn ? { component: fixedIn.component, version: fixedIn.version } : null,
    note,
    reporters: state.reporters,
    reports: state.reports,
  };
}

async function assertCollecting(user: SessionUser) {
  if (!(await isFeedbackAreaEnabled({ area: APPS_PLATFORM_FEEDBACK_AREA, user })))
    throw new TRPCError({ code: 'FORBIDDEN', message: FEEDBACK_AREA_DISABLED_MESSAGE });
}

type ExistingRow = { id: number; status: string; server: unknown };

/** The transaction client, cut to what this module sends: raw statements only. */
type RawTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw' | '$executeRawUnsafe'>;

async function insertReport(
  tx: RawTx,
  {
    userId,
    message,
    report,
    fingerprint,
    now,
    regressionOf,
  }: {
    userId: number;
    message: string;
    report: PlatformFeedbackReport;
    fingerprint: string;
    now: string;
    regressionOf?: number;
  }
) {
  const context = {
    report,
    server: {
      fingerprint,
      reporters: 1,
      reports: 1,
      reporterIds: [userId],
      firstSeenAt: now,
      lastSeenAt: now,
      samples: [],
      ...(regressionOf === undefined ? {} : { regressionOf }),
    },
  };
  const [{ id }] = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
    INSERT INTO "Feedback" ("area", "userId", "message", "context")
    VALUES (${APPS_PLATFORM_FEEDBACK_AREA}, ${userId}::int, ${message}, ${JSON.stringify(
    context
  )}::jsonb)
    RETURNING "id"
  `);
  return id;
}

/**
 * Counts one more send on an existing row, in one statement so two senders cannot lose each
 * other's increment. `reporters`, `reporterIds` and `samples` move only for a user the row has not
 * seen. Once `reporterIds` is full it stops recording new users, so past that many distinct
 * reporters a returning one is counted again and `reporters` is an upper bound.
 */
async function countRepeat(
  tx: RawTx,
  {
    id,
    userId,
    message,
    report,
    now,
  }: { id: number; userId: number; message: string; report: PlatformFeedbackReport; now: string }
) {
  const sample = JSON.stringify({
    userId,
    text: message.slice(0, PLATFORM_FEEDBACK_SAMPLE_TEXT_MAX_LENGTH),
    clientVersion: report.client.version,
  });
  const [row] = await tx.$queryRaw<Array<{ server: unknown }>>(Prisma.sql`
    UPDATE "Feedback" f
    SET "context" = jsonb_set(
      f."context",
      '{server}',
      (f."context"->'server')
        || jsonb_build_object(
             'reports', COALESCE((f."context"->'server'->>'reports')::int, 0) + 1,
             'lastSeenAt', ${now}::text
           )
        || CASE
             WHEN COALESCE(f."context"->'server'->'reporterIds', '[]'::jsonb) @> to_jsonb(${userId}::int)
               THEN '{}'::jsonb
             ELSE jsonb_build_object(
               'reporters', COALESCE((f."context"->'server'->>'reporters')::int, 0) + 1,
               'reporterIds',
                 CASE
                   WHEN jsonb_array_length(COALESCE(f."context"->'server'->'reporterIds', '[]'::jsonb)) < ${PLATFORM_FEEDBACK_REPORTER_IDS_MAX}::int
                     THEN COALESCE(f."context"->'server'->'reporterIds', '[]'::jsonb) || to_jsonb(${userId}::int)
                   ELSE f."context"->'server'->'reporterIds'
                 END,
               'samples',
                 CASE
                   WHEN jsonb_array_length(COALESCE(f."context"->'server'->'samples', '[]'::jsonb)) < ${PLATFORM_FEEDBACK_SAMPLES_MAX}::int
                     THEN COALESCE(f."context"->'server'->'samples', '[]'::jsonb) || jsonb_build_array(${sample}::jsonb)
                   ELSE f."context"->'server'->'samples'
                 END
             )
           END
    )
    WHERE f."id" = ${id}::int
    RETURNING f."context"->'server' AS "server"
  `);
  return parseServerState(row.server);
}

export async function createPlatformFeedback({
  user,
  input,
}: {
  user: SessionUser;
  input: CreatePlatformFeedbackInput;
}) {
  await assertCollecting(user);

  const { message, report } = input;
  const userId = user.id;
  const fingerprint = platformFeedbackFingerprint({ userId, message, report });
  const now = new Date().toISOString();

  return dbWrite.$transaction(async (tx: RawTx) => {
    // Postgres has no parameter form for SET, and an unbounded advisory-lock wait would hold a
    // write-pool backend for as long as the holder is wedged.
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    // Serialises senders of one fingerprint: without it two first reports both find no row and
    // both insert.
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${APPS_PLATFORM_FEEDBACK_AREA}:${fingerprint}`}::text, 0))`
    );

    const [existing] = await tx.$queryRaw<ExistingRow[]>(Prisma.sql`
      SELECT f."id", f."status", f."context"->'server' AS "server"
      FROM "Feedback" f
      WHERE f."area" = ${APPS_PLATFORM_FEEDBACK_AREA}
        AND f."context"->'server'->>'fingerprint' = ${fingerprint}
      ORDER BY f."id" DESC
      LIMIT 1
    `);

    const regression =
      existing?.status === 'actioned' && hasFix(report, parseServerState(existing.server));

    if (!existing || regression) {
      const id = await insertReport(tx, {
        userId,
        message,
        report,
        fingerprint,
        now,
        regressionOf: existing?.id,
      });
      return {
        ref: toRef(id, fingerprint),
        duplicate: false,
        status: 'received' as PlatformFeedbackReadbackStatus,
        fixedIn: null,
        note: null,
        reporters: 1,
        reports: 1,
      };
    }

    const state = await countRepeat(tx, { id: existing.id, userId, message, report, now });
    return {
      ref: toRef(existing.id, fingerprint),
      duplicate: true,
      ...toReadback(existing.status, state),
    };
  });
}

type StatusRow = ExistingRow & { handledAtMs: number | null };

const latestIso = (...values: Array<string | number | null | undefined>) => {
  const times = values
    .map((v) => (typeof v === 'string' ? Date.parse(v) : v))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
};

export async function getPlatformFeedbackStatus({
  user,
  input,
}: {
  user: SessionUser;
  input: GetPlatformFeedbackStatusInput;
}) {
  await assertCollecting(user);

  const parsed = input.refs.map((ref) => ({ ref, parsed: parseRef(ref) }));
  const ids = [...new Set(parsed.flatMap((p) => (p.parsed ? [p.parsed.id] : [])))];

  // The primary: a sender asks about a ref it was handed a moment ago, and a lagging replica
  // would answer that it does not exist. Bounded to 50 primary-key lookups per call.
  const rows = ids.length
    ? await dbWrite.$queryRaw<StatusRow[]>(Prisma.sql`
        SELECT f."id", f."status", f."context"->'server' AS "server",
               (EXTRACT(EPOCH FROM f."handledAt") * 1000)::float8 AS "handledAtMs"
        FROM "Feedback" f
        WHERE f."id" IN (${Prisma.join(ids)})
          AND f."area" = ${APPS_PLATFORM_FEEDBACK_AREA}
      `)
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  return parsed.map(({ ref, parsed: target }) => {
    const row = target ? byId.get(target.id) : undefined;
    const state = row ? parseServerState(row.server) : undefined;
    // The suffix is what makes a ref unguessable from its id: without the match, counting up
    // through ids would read out every report's status.
    if (!target || !row || !state || toRef(row.id, state.fingerprint) !== ref)
      return { ref, found: false as const };

    const { status, fixedIn, note, reporters } = toReadback(row.status, state);
    return {
      ref,
      found: true as const,
      status,
      fixedIn,
      note,
      reporters,
      firstSeenAt: state.firstSeenAt,
      updatedAt: latestIso(state.lastSeenAt, state.resolution?.at, row.handledAtMs),
    };
  });
}
