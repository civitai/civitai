import { createHash } from 'node:crypto';
import type { StoredConversationMetadata } from '@civitai/components-chat/core';
import { logToAxiom, safeError } from '~/server/logging/client';
import { isAppAssistantTracingOn } from '~/server/services/app-assistant/session-tracing.service';
import {
  computeTraceSignals,
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
    if (entry.dir || !SIGNAL_FILE.test(path)) continue;
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

/** The trace for one request, from `deps`. Never throws; returns what it wrote, or null. */
export async function buildSubmissionTrace(
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
  const signals = computeTraceSignals({ files, transcripts, defaultModel: deps.defaultModel });
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
