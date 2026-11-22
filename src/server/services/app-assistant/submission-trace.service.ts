import { createHash } from 'node:crypto';
import type { StoredConversationMetadata } from '@civitai/components-chat/core';
import { logToAxiom, safeError } from '~/server/logging/client';
import { isAppAssistantTracingOn } from '~/server/services/app-assistant/session-tracing.service';
import {
  computeTraceSignals,
  EXCLUDED_PATH,
  TRACE_SIGNALS_VERSION,
  type TraceSignals,
} from '~/shared/app-assistant/trace-signals';
import { transcriptView, type TranscriptView } from '~/shared/app-assistant/transcript-view';

/**
 * App Assistant session tracing, frozen at submission (`app_publish_request_traces`), and the
 * moderator reads over it.
 *
 * WRITE — `recordSubmissionTrace`, from `submitVersion` once the publish request exists, while the
 * `app-assistant-tracing` flag is on: the SUBMITTER's own link rows for the slug name the chats
 * (another user's link to the same slug is never pulled in); each chat is read as the submitter
 * (`transcriptReaderFor`) and frozen as JSON in the bundle store under `TRANSCRIPT_PREFIX`, so it
 * survives the user deleting the chat and stays tied to this exact version; the signals are computed
 * from the submitted bundle and those transcripts; one trace row records it all.
 *
 * 🔴 NEVER IN A SUBMISSION'S WAY. `recordSubmissionTrace` never throws: every failure is logged, and
 * recorded on the row as `snapshotError` when the row can still be written. A chat that cannot be
 * read is recorded with its error and the rest go on. The caller does not await it.
 */

/** The bundle-store prefix transcripts are frozen under: distinct from the bundles' own. */
export const TRANSCRIPT_PREFIX = 'app-assistant-transcripts';
/** The most chats one submission snapshots: the most recently active, by their link rows. */
export const MAX_TRACED_SESSIONS = 20;
/** Source files above this are not read for signals. */
const MAX_SIGNAL_FILE_BYTES = 512 * 1024;
const MAX_SIGNAL_TOTAL_BYTES = 8 * 1024 * 1024;
const SIGNAL_FILE =
  /\.(?:css|scss|sass|less|html?|[cm]?[jt]sx?|vue|svelte)$|(?:^|\/)package\.json$/i;

export interface SnapshotEntry {
  conversationId: string;
  /** The bundle-store key, when it was frozen. */
  key?: string;
  bytes?: number;
  turns?: number;
  /** Why this chat was not frozen. */
  error?: 'not-found' | 'read-failed' | 'store-failed' | 'consent' | 'unavailable';
}

/** The bundle-store key one chat of one request is frozen at. The chat id is hashed: it is page-chosen. */
export function transcriptKey(publishRequestId: string, conversationId: string): string {
  const id = createHash('sha256').update(conversationId).digest('hex').slice(0, 32);
  return `${TRANSCRIPT_PREFIX}/${publishRequestId}/${id}.json`;
}

/** The bundle's text files the signals read (path → UTF-8), within the caps above. */
export async function bundleSignalFiles(bundleBuffer: Buffer): Promise<Map<string, string>> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bundleBuffer);
  const files = new Map<string, string>();
  let total = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    // Excluded paths (dependencies, build output, tests) are skipped BEFORE the budget: a vendored
    // `node_modules` must not use it up and push the app's own source out.
    if (entry.dir || !SIGNAL_FILE.test(path) || EXCLUDED_PATH.test(path)) continue;
    const bytes = await entry.async('uint8array');
    if (bytes.length > MAX_SIGNAL_FILE_BYTES || total + bytes.length > MAX_SIGNAL_TOTAL_BYTES)
      continue;
    total += bytes.length;
    files.set(path, Buffer.from(bytes).toString('utf8'));
  }
  return files;
}

export interface SubmissionTraceInput {
  publishRequestId: string;
  slug: string;
  submittedByUserId: number;
  bundleBuffer: Buffer;
  /** Chats to trace in place of the link rows' (the backfill's own finding). */
  conversationIds?: string[];
}

export interface SubmissionTraceDeps {
  links(slug: string, userId: number): Promise<string[]>;
  reader(
    userId: number
  ): Promise<
    | { read(conversationId: string): Promise<StoredConversationMetadata | null> }
    | { refused: 'consent' | 'unavailable' }
  >;
  store(key: string, body: string): Promise<void>;
  files(bundleBuffer: Buffer): Promise<Map<string, string>>;
  write(row: {
    publishRequestId: string;
    slug: string;
    userId: number;
    conversationIds: string[];
    snapshots: SnapshotEntry[];
    signals: TraceSignals;
    signalsVersion: number;
    snapshotError: string | null;
  }): Promise<void>;
  defaultModel: string;
  now(): Date;
}

/**
 * The trace for one request, from `deps`. Never throws: anything the steps below did not catch
 * themselves is logged and answered with null (no row written).
 */
export async function buildSubmissionTrace(
  input: SubmissionTraceInput,
  deps: SubmissionTraceDeps
): ReturnType<typeof buildTrace> {
  try {
    return await buildTrace(input, deps);
  } catch (err) {
    logToAxiom({
      type: 'warning',
      name: 'app-assistant.tracing.trace-failed',
      message: 'App Assistant submission trace failed',
      userId: input.submittedByUserId,
      error: safeError(err),
      payload: { publishRequestId: input.publishRequestId },
    });
    return null;
  }
}

async function buildTrace(
  input: SubmissionTraceInput,
  deps: SubmissionTraceDeps
): Promise<{
  snapshots: SnapshotEntry[];
  signals: TraceSignals;
  snapshotError: string | null;
} | null> {
  const problems: string[] = [];
  let conversationIds: string[] = [];
  try {
    conversationIds = (
      input.conversationIds ?? (await deps.links(input.slug, input.submittedByUserId))
    ).slice(0, MAX_TRACED_SESSIONS);
  } catch (err) {
    problems.push(`links: ${(err as Error)?.message ?? 'failed'}`);
  }

  const snapshots: SnapshotEntry[] = [];
  const transcripts: StoredConversationMetadata[] = [];
  if (conversationIds.length) {
    let reader: Awaited<ReturnType<SubmissionTraceDeps['reader']>>;
    try {
      reader = await deps.reader(input.submittedByUserId);
    } catch {
      reader = { refused: 'unavailable' };
    }
    if ('refused' in reader) {
      const refused = reader.refused;
      problems.push(`transcripts: ${refused}`);
      for (const conversationId of conversationIds)
        snapshots.push({ conversationId, error: refused });
    } else {
      for (const conversationId of conversationIds) {
        let metadata: StoredConversationMetadata | null;
        try {
          metadata = await reader.read(conversationId);
        } catch {
          snapshots.push({ conversationId, error: 'read-failed' });
          continue;
        }
        if (!metadata) {
          snapshots.push({ conversationId, error: 'not-found' });
          continue;
        }
        const key = transcriptKey(input.publishRequestId, conversationId);
        const body = JSON.stringify({
          v: 1,
          publishRequestId: input.publishRequestId,
          slug: input.slug,
          userId: input.submittedByUserId,
          conversationId,
          capturedAt: deps.now().toISOString(),
          metadata,
        });
        try {
          await deps.store(key, body);
          // Only a frozen chat feeds the signals: they describe exactly what the snapshot holds.
          transcripts.push(metadata);
          snapshots.push({
            conversationId,
            key,
            bytes: Buffer.byteLength(body),
            turns: metadata.turns?.length ?? 0,
          });
        } catch {
          snapshots.push({ conversationId, error: 'store-failed' });
        }
      }
      const failed = snapshots.filter((entry) => entry.error).length;
      if (failed) problems.push(`${failed} of ${conversationIds.length} chats not frozen`);
    }
  }

  let files = new Map<string, string>();
  try {
    files = await deps.files(input.bundleBuffer);
  } catch (err) {
    problems.push(`bundle: ${(err as Error)?.message ?? 'unreadable'}`);
  }
  let signals: TraceSignals;
  try {
    signals = computeTraceSignals({ files, transcripts, defaultModel: deps.defaultModel });
  } catch (err) {
    // The row is still written (it names the chats and where they are frozen), without signals.
    problems.push(`signals: ${(err as Error)?.message ?? 'failed'}`);
    signals = computeTraceSignals({
      files: new Map(),
      transcripts: [],
      defaultModel: deps.defaultModel,
    });
  }
  const snapshotError = problems.length ? problems.join('; ').slice(0, 1000) : null;
  try {
    await deps.write({
      publishRequestId: input.publishRequestId,
      slug: input.slug,
      userId: input.submittedByUserId,
      conversationIds,
      snapshots,
      signals,
      signalsVersion: TRACE_SIGNALS_VERSION,
      snapshotError,
    });
  } catch (err) {
    logToAxiom({
      type: 'warning',
      name: 'app-assistant.tracing.trace-write-failed',
      message: 'App Assistant submission trace not written',
      userId: input.submittedByUserId,
      error: safeError(err),
      payload: { publishRequestId: input.publishRequestId },
    });
    return null;
  }
  return { snapshots, signals, snapshotError };
}

/** The real dependencies: the link table, the submitter's chats, the bundle store, the trace table. */
export async function liveSubmissionTraceDeps(): Promise<SubmissionTraceDeps> {
  const [{ dbRead, dbWrite }, { transcriptReaderFor }, s3, { PutObjectCommand }, assistant] =
    await Promise.all([
      import('~/server/db/client'),
      import('~/server/services/app-assistant/session-transcripts'),
      import('~/utils/bundle-s3'),
      import('@aws-sdk/client-s3'),
      import('@civitai/app-assistant'),
    ]);
  return {
    links: async (slug, userId) =>
      (
        await dbRead.appAssistantSessionLink.findMany({
          where: { appSlug: slug, userId },
          orderBy: { lastSeenAt: 'desc' },
          take: MAX_TRACED_SESSIONS,
          select: { conversationId: true },
        })
      ).map((link) => link.conversationId),
    reader: transcriptReaderFor,
    store: async (key, body) => {
      await s3.getBundleS3Client().send(
        new PutObjectCommand({
          Bucket: s3.getBundleBucket(),
          Key: key,
          Body: body,
          ContentType: 'application/json',
        })
      );
    },
    files: bundleSignalFiles,
    write: async (row) => {
      await dbWrite.appPublishRequestTrace.create({
        data: {
          ...row,
          snapshots: row.snapshots as object[],
          signals: row.signals as object,
        },
        select: { id: true },
      });
    },
    defaultModel: assistant.APP_ASSISTANT_DEFAULT_MODEL,
    now: () => new Date(),
  };
}

/**
 * `submitVersion`'s hook: a no-op while the flag is off. Never throws, so a caller may fire it
 * without awaiting.
 */
export async function recordSubmissionTrace(input: SubmissionTraceInput): Promise<void> {
  try {
    if (!(await isAppAssistantTracingOn())) return;
    await buildSubmissionTrace(input, await liveSubmissionTraceDeps());
  } catch (err) {
    logToAxiom({
      type: 'warning',
      name: 'app-assistant.tracing.trace-failed',
      message: 'App Assistant submission trace failed',
      userId: input.submittedByUserId,
      error: safeError(err),
      payload: { publishRequestId: input.publishRequestId },
    });
  }
}

// ─── retention: deleted with the account ───────────────────────────────────────────────────
//
// A trace is kept as long as its publish request exists, whatever the user does to the chat itself,
// and is deleted when the user's ACCOUNT is: the frozen transcripts in the bundle store, then the
// trace rows. Account deletion here is a SOFT delete (`deleteUser` scrubs the User row and keeps it),
// so the tables' ON DELETE CASCADE never fires for it. `deleteUser` runs two independent steps:
// `delete-app-assistant-links` (the link rows, `deleteSessionLinksOfAccount`) and
// `delete-app-assistant-traces` (this). A deletion that could not finish (a transcript the store
// refused) keeps its trace rows, and the hourly `sweep-app-assistant-traces` job retries it
// (`sweepDeletedAccountTraces`) until it does.
//
// No code path deletes a publish request row today; if one is ever added, the trace row cascades
// with it, and its frozen transcripts must be deleted there too (`deleteTraceSnapshots`), since the
// store has no cascade.

export interface TraceDeletionDeps {
  /** The traces of submissions this user made; none while the table is not applied. */
  traces(userId: number): Promise<Array<{ publishRequestId: string; snapshots: unknown }>>;
  /** Every key in the bundle store under `prefix`. */
  listKeys(prefix: string): Promise<string[]>;
  deleteObject(key: string): Promise<void>;
  /** Deletes the user's trace rows; how many. */
  deleteTraceRows(userId: number): Promise<number>;
}

export interface TraceDeletion {
  objects: number;
  failedObjects: number;
  traces: number;
}

/**
 * Deletes one request's frozen transcripts: every key its trace names, and every key under the
 * request's own prefix (a snapshot whose row entry was lost is found that way). Returns how many
 * were deleted and how many could not be.
 */
export async function deleteTraceSnapshots(
  trace: { publishRequestId: string; snapshots: unknown },
  deps: Pick<TraceDeletionDeps, 'listKeys' | 'deleteObject'>
): Promise<{ deleted: number; failed: number }> {
  const prefix = `${TRANSCRIPT_PREFIX}/${trace.publishRequestId}/`;
  const keys = new Set<string>();
  for (const entry of Array.isArray(trace.snapshots) ? (trace.snapshots as SnapshotEntry[]) : [])
    if (typeof entry?.key === 'string' && entry.key.startsWith(prefix)) keys.add(entry.key);
  let failed = 0;
  try {
    for (const key of await deps.listKeys(prefix)) keys.add(key);
  } catch {
    // The listing failing still leaves the row's own keys to delete; counted as one failure.
    failed++;
  }
  let deleted = 0;
  for (const key of keys) {
    try {
      await deps.deleteObject(key);
      deleted++;
    } catch {
      failed++;
    }
  }
  return { deleted, failed };
}

/**
 * One account's traces, deleted: frozen transcripts first, then the trace rows. If any transcript
 * could not be deleted the ROWS ARE KEPT, so they still name what is left, and the sweep retries
 * them (the failure is logged). Never throws.
 */
export async function deleteAssistantTracesOfAccount(
  userId: number,
  deps: TraceDeletionDeps
): Promise<TraceDeletion> {
  const outcome: TraceDeletion = { objects: 0, failedObjects: 0, traces: 0 };
  try {
    for (const trace of await deps.traces(userId)) {
      const { deleted, failed } = await deleteTraceSnapshots(trace, deps);
      outcome.objects += deleted;
      outcome.failedObjects += failed;
    }
    if (outcome.failedObjects === 0) outcome.traces = await deps.deleteTraceRows(userId);
  } catch (err) {
    outcome.failedObjects++;
    logToAxiom({
      type: 'error',
      name: 'app-assistant.tracing.account-delete-failed',
      message: 'App Assistant traces of a deleted account were not all deleted',
      userId,
      error: safeError(err),
    });
    return outcome;
  }
  if (outcome.failedObjects > 0)
    logToAxiom({
      type: 'error',
      name: 'app-assistant.tracing.account-delete-partial',
      message: 'Some frozen App Assistant transcripts of a deleted account were not deleted',
      userId,
      payload: { failedObjects: outcome.failedObjects, deletedObjects: outcome.objects },
    });
  return outcome;
}

export interface TraceSweepDeps {
  /** Deleted accounts that still have trace rows (at most `limit`); none while the table is not applied. */
  deletedAccountsWithTraces(limit: number): Promise<number[]>;
  /** The content-removal hold: `false` = not held; `true` or `null` (unreadable) = keep. */
  isHeld(userId: number): Promise<boolean | null>;
  deletion: TraceDeletionDeps;
}

/** Accounts one sweep run finishes at most; the next run takes the rest. */
export const TRACE_SWEEP_BATCH = 200;

/**
 * The retry of unfinished trace deletions (the `sweep-app-assistant-traces` job): every deleted
 * account that still has trace rows, unless its content removal is held, is deleted again. Counts
 * per run; never throws for one account.
 */
export async function sweepDeletedAccountTraces(deps: TraceSweepDeps) {
  const accounts = await deps.deletedAccountsWithTraces(TRACE_SWEEP_BATCH);
  const summary = { accounts: accounts.length, finished: 0, held: 0, failed: 0 };
  for (const userId of accounts) {
    if ((await deps.isHeld(userId).catch(() => null)) !== false) {
      summary.held++;
      continue;
    }
    const outcome = await deleteAssistantTracesOfAccount(userId, deps.deletion);
    if (outcome.failedObjects > 0) summary.failed++;
    else summary.finished++;
  }
  return summary;
}

/**
 * The real dependencies of `deleteAssistantTracesOfAccount`. `isMissingTable` is the caller's
 * (`app-access.service`'s), passed in so this module does not reach that service's graph.
 */
export async function liveTraceDeletionDeps(
  isMissingTable: (err: unknown) => boolean
): Promise<TraceDeletionDeps> {
  const [{ dbWrite }, s3, { ListObjectsV2Command, DeleteObjectCommand }] = await Promise.all([
    import('~/server/db/client'),
    import('~/utils/bundle-s3'),
    import('@aws-sdk/client-s3'),
  ]);
  return {
    traces: async (userId) => {
      try {
        // primary: the account was deleted this request; its newest trace must not be missed.
        return await dbWrite.appPublishRequestTrace.findMany({
          where: { userId },
          select: { publishRequestId: true, snapshots: true },
        });
      } catch (err) {
        // The table not applied yet holds no traces: nothing to delete, not a failure.
        if (isMissingTable(err)) return [];
        throw err;
      }
    },
    listKeys: async (prefix) => {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await s3.getBundleS3Client().send(
          new ListObjectsV2Command({
            Bucket: s3.getBundleBucket(),
            Prefix: prefix,
            ...(token ? { ContinuationToken: token } : {}),
          })
        );
        for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    deleteObject: async (key) => {
      await s3
        .getBundleS3Client()
        .send(new DeleteObjectCommand({ Bucket: s3.getBundleBucket(), Key: key }));
    },
    deleteTraceRows: async (userId) => {
      try {
        return (await dbWrite.appPublishRequestTrace.deleteMany({ where: { userId } })).count;
      } catch (err) {
        if (isMissingTable(err)) return 0;
        throw err;
      }
    },
  };
}

/** The real dependencies of `sweepDeletedAccountTraces`. */
export async function liveTraceSweepDeps({
  isMissingTable,
  isHeld,
}: {
  isMissingTable: (err: unknown) => boolean;
  isHeld: (userId: number) => Promise<boolean | null>;
}): Promise<TraceSweepDeps> {
  const { dbWrite } = await import('~/server/db/client');
  return {
    deletedAccountsWithTraces: async (limit) => {
      try {
        // primary: what is left of a deletion that just ran is read where it was written.
        const rows = await dbWrite.$queryRaw<Array<{ user_id: number }>>`
          SELECT DISTINCT t.user_id
          FROM app_publish_request_traces t
          JOIN "User" u ON u.id = t.user_id
          WHERE u."deletedAt" IS NOT NULL
          ORDER BY t.user_id
          LIMIT ${limit}
        `;
        return rows.map((row) => row.user_id);
      } catch (err) {
        if (isMissingTable(err)) return [];
        throw err;
      }
    },
    isHeld,
    deletion: await liveTraceDeletionDeps(isMissingTable),
  };
}

// ─── reads (moderator-only: every caller is a moderator endpoint) ────────────────────────────

const traceSelect = {
  publishRequestId: true,
  slug: true,
  userId: true,
  conversationIds: true,
  snapshots: true,
  signals: true,
  signalsVersion: true,
  snapshotError: true,
  createdAt: true,
} as const;

const requestSelect = {
  id: true,
  slug: true,
  version: true,
  status: true,
  submittedAt: true,
  submittedByUserId: true,
} as const;

const linkSelect = {
  userId: true,
  conversationId: true,
  appSlug: true,
  firstSeenAt: true,
  lastSeenAt: true,
  turnCount: true,
  lastModel: true,
  buzzTotal: true,
} as const;

/** One request, its trace (null when none was recorded) and the submitter's link rows as they stand now. */
export async function getRequestTrace(publishRequestId: string) {
  const { dbRead } = await import('~/server/db/client');
  const request = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: requestSelect,
  });
  if (!request) return null;
  const [trace, links] = await Promise.all([
    dbRead.appPublishRequestTrace.findUnique({ where: { publishRequestId }, select: traceSelect }),
    dbRead.appAssistantSessionLink.findMany({
      where: { appSlug: request.slug, userId: request.submittedByUserId },
      orderBy: { lastSeenAt: 'desc' },
      take: 100,
      select: linkSelect,
    }),
  ]);
  return { request, trace, links };
}

/** An app's requests (newest first, paginated by request id) with their traces, and every link to it. */
export async function getAppTraces(
  slug: string,
  { limit, cursor }: { limit: number; cursor?: string }
) {
  const { dbRead } = await import('~/server/db/client');
  const requests = await dbRead.appBlockPublishRequest.findMany({
    where: { slug },
    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { ...requestSelect, assistantTrace: { select: traceSelect } },
  });
  const page = requests.slice(0, limit);
  const links = await dbRead.appAssistantSessionLink.findMany({
    where: { appSlug: slug },
    orderBy: { lastSeenAt: 'desc' },
    take: 200,
    select: linkSelect,
  });
  return {
    requests: page.map(({ assistantTrace, ...request }) => ({ request, trace: assistantTrace })),
    nextCursor: requests.length > limit ? page[page.length - 1]!.id : null,
    // Links are each chat's own claim; only a submitter's link fed that submitter's trace.
    links,
  };
}

export type TranscriptRead =
  | { ok: true; capturedAt: string | null; transcript: TranscriptView }
  | { ok: false; reason: 'no-trace' | 'not-in-trace' | 'not-frozen' | 'unreadable' };

/** One frozen chat of one request, rendered (`transcriptView`). */
export async function readSnapshotTranscript(
  publishRequestId: string,
  conversationId: string,
  { toolOutputChars }: { toolOutputChars?: number } = {}
): Promise<TranscriptRead> {
  const { dbRead } = await import('~/server/db/client');
  const trace = await dbRead.appPublishRequestTrace.findUnique({
    where: { publishRequestId },
    select: { snapshots: true },
  });
  if (!trace) return { ok: false, reason: 'no-trace' };
  const entry = ((trace.snapshots ?? []) as unknown as SnapshotEntry[]).find(
    (snapshot) => snapshot.conversationId === conversationId
  );
  if (!entry) return { ok: false, reason: 'not-in-trace' };
  if (!entry.key) return { ok: false, reason: 'not-frozen' };
  const [s3, { GetObjectCommand }] = await Promise.all([
    import('~/utils/bundle-s3'),
    import('@aws-sdk/client-s3'),
  ]);
  try {
    const object = await s3
      .getBundleS3Client()
      .send(new GetObjectCommand({ Bucket: s3.getBundleBucket(), Key: entry.key }));
    const body = JSON.parse((await object.Body?.transformToString('utf-8')) ?? 'null') as {
      capturedAt?: string;
      metadata?: unknown;
    } | null;
    if (!body?.metadata) return { ok: false, reason: 'unreadable' };
    return {
      ok: true,
      capturedAt: typeof body.capturedAt === 'string' ? body.capturedAt : null,
      transcript: transcriptView(body.metadata, { toolOutputChars }),
    };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

export interface SignalsWeek {
  week: string;
  submissions: number;
  withSessions: number;
  themeCustomized: number;
  themeDefault: number;
  themeUnknown: number;
  avgTurns: number | null;
  avgBuzz: number | null;
}

/** Signals in aggregate over `[from, to)`: per ISO week, and per docs topic read. */
export async function aggregateSignals({ from, to }: { from: Date; to: Date }) {
  const { dbRead } = await import('~/server/db/client');
  const weeks = await dbRead.$queryRaw<
    Array<{
      week: Date;
      submissions: bigint;
      with_sessions: bigint;
      customized: bigint;
      default_theme: bigint;
      unknown_theme: bigint;
      avg_turns: number | null;
      avg_buzz: number | null;
    }>
  >`
    SELECT date_trunc('week', created_at) AS week,
           count(*) AS submissions,
           count(*) FILTER (WHERE cardinality(conversation_ids) > 0) AS with_sessions,
           count(*) FILTER (WHERE signals->>'themeCustomized' = 'true') AS customized,
           count(*) FILTER (WHERE signals->>'themeCustomized' = 'false') AS default_theme,
           count(*) FILTER (WHERE coalesce(signals->>'themeCustomized', 'null') = 'null') AS unknown_theme,
           avg((signals->>'turnCount')::float) FILTER (WHERE cardinality(conversation_ids) > 0) AS avg_turns,
           avg((signals->>'buzzTotal')::float) FILTER (WHERE cardinality(conversation_ids) > 0) AS avg_buzz
    FROM app_publish_request_traces
    WHERE created_at >= ${from} AND created_at < ${to}
    GROUP BY 1 ORDER BY 1
  `;
  const topics = await dbRead.$queryRaw<
    Array<{ topic: string; submissions: bigint; customized: bigint }>
  >`
    SELECT topic,
           count(*) AS submissions,
           count(*) FILTER (WHERE signals->>'themeCustomized' = 'true') AS customized
    FROM app_publish_request_traces,
         jsonb_array_elements_text(coalesce(signals->'readDocsTopics', '[]'::jsonb)) AS topic
    WHERE created_at >= ${from} AND created_at < ${to}
    GROUP BY topic ORDER BY 2 DESC, topic LIMIT 50
  `;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    weeks: weeks.map(
      (row): SignalsWeek => ({
        week: row.week.toISOString().slice(0, 10),
        submissions: Number(row.submissions),
        withSessions: Number(row.with_sessions),
        themeCustomized: Number(row.customized),
        themeDefault: Number(row.default_theme),
        themeUnknown: Number(row.unknown_theme),
        avgTurns: row.avg_turns === null ? null : Number(row.avg_turns),
        avgBuzz: row.avg_buzz === null ? null : Number(row.avg_buzz),
      })
    ),
    docsTopics: topics.map((row) => ({
      topic: row.topic,
      submissions: Number(row.submissions),
      themeCustomized: Number(row.customized),
    })),
  };
}
