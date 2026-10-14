import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import semver from 'semver';
import { parsePlatformFeedbackVersion as parseVersion } from '@civitai/shared/platform-feedback-version';
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
import {
  APPS_PLATFORM_FEEDBACK_AREA,
  PLATFORM_FEEDBACK_CLIENT_COMPONENT as CLIENT_COMPONENT,
  PLATFORM_FEEDBACK_PUBLIC_NOTE_MAX_LENGTH as PUBLIC_NOTE_MAX_LENGTH,
} from '~/shared/constants/feedback.constants';
import type { SessionUser } from '~/types/session';

/**
 * Developer-platform feedback (`Feedback.area = 'apps-platform'`). The stored context is
 * `{ report, server }`: `report` is the parsed client input, `server` is composed here and never
 * read from the client.
 */

export const PLATFORM_FEEDBACK_REPORTER_IDS_MAX = 50;
export const PLATFORM_FEEDBACK_SAMPLES_MAX = 5;
export const PLATFORM_FEEDBACK_SAMPLE_TEXT_MAX_LENGTH = 300;
/**
 * How many new reporters one dismissal absorbs before the next new one opens a fresh row instead
 * of being told `not_planned`. The count is per dismissal: dismissing the row again starts it over.
 */
export const PLATFORM_FEEDBACK_REOPEN_AFTER_REPORTERS = 3;
const REF_SUFFIX_LENGTH = 8;
const LOCK_TIMEOUT = '3s';
const INT4_MAX = 2_147_483_647;

/** Shared with the moderator app, which explains the regression compare beside the resolution form. */
export const PLATFORM_FEEDBACK_CLIENT_COMPONENT: Partial<Record<PlatformFeedbackClient, string>> =
  CLIENT_COMPONENT;

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

/**
 * Has this reporter already got the fix? Only then is a repeat of a fixed report a regression.
 * A version that does not parse counts as not having it, so it never opens a regression row.
 *
 * The client name and version are whatever the caller declares, so anyone can open a regression
 * row by declaring a high version. That is bounded to one row per fix: the new row becomes the
 * newest for the fingerprint and is not `actioned`, so later reports are counted on it.
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
  const stored = state.resolution?.fixedIn;
  const fixedIn = stored?.version.trim() ? stored : null;
  const note = state.resolution?.publicNote?.slice(0, PUBLIC_NOTE_MAX_LENGTH) || null;
  return {
    status: readbackStatus(status, !!fixedIn),
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
/** `provablyNew`: the caller is not in `reporterIds` and the list still has room to say so. */
type LookupRow = ExistingRow & { provablyNew: boolean; postCloseCount: number };

/**
 * Which dismissal a row is under: its `handledAt`, which the moderator app stamps on every status
 * change. A row nobody stamped still gets a value, so its count has something to match.
 */
const CLOSE_ANCHOR = Prisma.sql`COALESCE((EXTRACT(EPOCH FROM f."handledAt") * 1000)::bigint::text, 'unhandled')`;

/**
 * New reporters counted under the row's CURRENT dismissal. A count stored for another dismissal,
 * or with none named, reads as zero: otherwise a row dismissed a second time would reopen on the
 * reporters the first dismissal had already absorbed.
 */
const POST_CLOSE_COUNT = Prisma.sql`(CASE
  WHEN f."context"->'server'->>'postCloseFor' IS NOT DISTINCT FROM ${CLOSE_ANCHOR}
    THEN COALESCE((f."context"->'server'->>'postCloseReporters')::int, 0)
  ELSE 0
END)`;

/**
 * `context.server` without the two fields only moderators read. Every read here selects this, so
 * reporter ids and sample text never leave the database on a path that answers a reporter.
 */
const SERVER_STATE = Prisma.sql`CASE WHEN jsonb_typeof(f."context"->'server') = 'object' THEN (f."context"->'server') - 'reporterIds' - 'samples' END`;

/**
 * The first 300 UTF-16 units, minus a surrogate pair the cut split: a lone surrogate is not valid
 * JSON to Postgres, and would fail the statement for every later repeat of the report.
 */
const sampleText = (message: string) =>
  message.slice(0, PLATFORM_FEEDBACK_SAMPLE_TEXT_MAX_LENGTH).replace(/[\uD800-\uDBFF]$/, '');

type RawTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw' | '$executeRawUnsafe'>;

async function insertReport(
  tx: RawTx,
  {
    userId,
    message,
    report,
    fingerprint,
    now,
    link,
  }: {
    userId: number;
    message: string;
    report: PlatformFeedbackReport;
    fingerprint: string;
    now: string;
    /** The closed row this one follows, when it is not the first for its fingerprint. */
    link?: { regressionOf: number } | { reopenOf: number };
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
      ...link,
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
 *
 * On a dismissed row (`closed`) a new reporter is also counted in `postCloseReporters`, for the
 * dismissal named by `postCloseFor`, but only while their id can still be recorded: past the cap
 * nobody can be shown to be new.
 */
async function countRepeat(
  tx: RawTx,
  {
    id,
    userId,
    message,
    report,
    now,
    closed,
  }: {
    id: number;
    userId: number;
    message: string;
    report: PlatformFeedbackReport;
    now: string;
    closed: boolean;
  }
) {
  const sample = JSON.stringify({
    userId,
    text: sampleText(message),
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
             WHEN f."context"->'server'->'reporterIds' @> to_jsonb(${userId}::int)
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
             ) || CASE
               WHEN ${closed}::boolean
                 AND jsonb_array_length(COALESCE(f."context"->'server'->'reporterIds', '[]'::jsonb)) < ${PLATFORM_FEEDBACK_REPORTER_IDS_MAX}::int
                 THEN jsonb_build_object(
                   'postCloseReporters', ${POST_CLOSE_COUNT} + 1,
                   'postCloseFor', ${CLOSE_ANCHOR}
                 )
               ELSE '{}'::jsonb
             END
           END
    )
    WHERE f."id" = ${id}::int
    RETURNING ${SERVER_STATE} AS "server"
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

    const [existing] = await tx.$queryRaw<LookupRow[]>(Prisma.sql`
      SELECT f."id", f."status", ${SERVER_STATE} AS "server",
             (NOT COALESCE(f."context"->'server'->'reporterIds' @> to_jsonb(${userId}::int), false)
               AND jsonb_array_length(COALESCE(f."context"->'server'->'reporterIds', '[]'::jsonb)) < ${PLATFORM_FEEDBACK_REPORTER_IDS_MAX}::int
             ) AS "provablyNew",
             ${POST_CLOSE_COUNT} AS "postCloseCount"
      FROM "Feedback" f
      WHERE f."area" = ${APPS_PLATFORM_FEEDBACK_AREA}
        AND f."context"->'server'->>'fingerprint' = ${fingerprint}
      ORDER BY f."id" DESC
      LIMIT 1
    `);

    const before = existing && parseServerState(existing.server);
    const regression = existing?.status === 'actioned' && !!before && hasFix(report, before);
    // A report keyed on `report.ref` is one row for every user, so without this a dismissed first
    // report would answer `not_planned` to everyone who hits that failure site afterwards.
    const reopen =
      existing?.status === 'dismissed' &&
      existing.provablyNew &&
      existing.postCloseCount >= PLATFORM_FEEDBACK_REOPEN_AFTER_REPORTERS;

    if (!existing || regression || reopen) {
      const id = await insertReport(tx, {
        userId,
        message,
        report,
        fingerprint,
        now,
        link: !existing
          ? undefined
          : regression
          ? { regressionOf: existing.id }
          : { reopenOf: existing.id },
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

    const state = await countRepeat(tx, {
      id: existing.id,
      userId,
      message,
      report,
      now,
      closed: existing.status === 'dismissed',
    });
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
  // would answer that it does not exist.
  const rows = ids.length
    ? await dbWrite.$queryRaw<StatusRow[]>(Prisma.sql`
        SELECT f."id", f."status", ${SERVER_STATE} AS "server",
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
    // Without the suffix match, counting up through ids would read out every report. The suffix
    // is not a secret for a report keyed on `report.ref` (it derives from about + ref), so anyone
    // with the area enabled who can guess the key and id reads such a row here — status, fixedIn,
    // the moderator's public note, counts and timing. Never reporter ids or sample text.
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
