import { parseArgs } from 'util';

import { dbRead, dbWrite } from '~/server/db/client';
import { transcriptReaderFor } from '~/server/services/app-assistant/session-transcripts';
import {
  buildSubmissionTrace,
  liveSubmissionTraceDeps,
} from '~/server/services/app-assistant/submission-trace.service';
import {
  backfillPage,
  runTraceBackfill,
  writeReplacingEmptyTrace,
} from '~/server/services/app-assistant/trace-backfill';
import { runScriptAndExit } from './lib/run-as-script';

/**
 * Backfill App Assistant session traces for publish requests that predate session tracing (or were
 * submitted while its flag was off): for each request with no trace, find the SUBMITTER's App
 * Assistant chats whose `create_app` / `use_open_app` / `wake_app` result named the request's slug,
 * and freeze them exactly as a submit does (`buildSubmissionTrace`, a trace row per request).
 *
 *   pnpm run tsscript scripts/backfill-app-assistant-traces.ts [--apply] [--since 2026-10-01]
 *     [--slug <slug>] [--request <publishRequestId>] [--limit 50] [--max-pages 20]
 *     [--before <publishRequestId>] [--include-empty]
 *
 * Modes:
 *   (default)  Dry run: reads requests and the submitters' chats, prints what it would trace for
 *              each, writes nothing.
 *   --apply    Also fetches each request's bundle and writes its snapshots and trace row.
 *
 * Progress: requests are paged newest first with a cursor, and every run ends with a
 * `next: --before <publishRequestId>` line. Pass it to the next run to carry on past everything this
 * one looked at, skipped requests (chats that could not be read) included, so a bulk backfill always
 * moves forward. A request that fails is logged and the run goes on.
 *
 * `--include-empty` also re-traces requests whose trace froze NO chat (an app built before the
 * links existed, submitted while tracing was on): the empty trace is replaced, never one with chats.
 *
 * Idempotent: a request that already has a trace with chats is never touched. Safe to stop and
 * re-run.
 *
 * What it cannot find, by construction:
 *   - chats the user deleted, or that are past `--max-pages` × 50 of their most recent chats;
 *   - chats of a user who has since turned App Assistant off (no token is minted for them);
 *   - a chat that worked on the app without choosing it by one of those calls (e.g. one that only
 *     edited files after a reload restored the choice in the browser);
 *   - the chat's state AT the submit: a chat is frozen as it is now, so turns after the submit are
 *     included (live traces freeze at submit);
 *   - push-originated requests (no bundle in the store) get chats but no bundle signals;
 *   - submissions not built in App Assistant (CLI): found nothing, which is the right answer.
 */

const LIST_PAGE_CAP = 20;

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean', default: false },
      since: { type: 'string' },
      slug: { type: 'string' },
      request: { type: 'string' },
      limit: { type: 'string', default: '50' },
      'max-pages': { type: 'string', default: String(LIST_PAGE_CAP) },
      before: { type: 'string' },
      'include-empty': { type: 'boolean', default: false },
    },
  });
  const limit = Math.max(1, Math.min(5000, Number(values.limit)));
  const maxPages = Math.max(1, Math.min(200, Number(values['max-pages'])));
  const deps = values.apply ? await liveSubmissionTraceDeps() : null;

  await runTraceBackfill(
    {
      apply: values.apply ?? false,
      limit,
      includeEmpty: values['include-empty'] ?? false,
      ...(values.before ? { before: values.before } : {}),
    },
    {
      page: ({ after, take, includeEmpty }) =>
        backfillPage(dbRead, {
          ...(after ? { after } : {}),
          take,
          includeEmpty,
          filters: {
            ...(values.request ? { id: values.request } : {}),
            ...(values.slug ? { slug: values.slug } : {}),
            ...(values.since ? { since: new Date(values.since) } : {}),
          },
        }),
      chatsOf: async (userId) => {
        const reader = await transcriptReaderFor(userId);
        if ('refused' in reader) return reader.refused;
        const all: { conversationId: string }[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < maxPages; page++) {
          const listed = await reader.list(cursor);
          all.push(...listed.items);
          if (!listed.next) break;
          cursor = listed.next;
        }
        return all;
      },
      trace: async (request, conversationIds) => {
        if (!deps) return null;
        let bundleBuffer = Buffer.alloc(0);
        if (request.bundleKey) {
          const [s3, { GetObjectCommand }] = await Promise.all([
            import('~/utils/bundle-s3'),
            import('@aws-sdk/client-s3'),
          ]);
          const object = await s3
            .getBundleS3Client()
            .send(new GetObjectCommand({ Bucket: s3.getBundleBucket(), Key: request.bundleKey }));
          bundleBuffer = Buffer.from((await object.Body?.transformToByteArray()) ?? []);
        }
        return buildSubmissionTrace(
          {
            publishRequestId: request.id,
            slug: request.slug,
            submittedByUserId: request.submittedByUserId,
            bundleBuffer,
            conversationIds,
          },
          { ...deps, write: async (row) => void (await writeReplacingEmptyTrace(dbWrite, row)) }
        );
      },
      log: (line) => console.log(line),
    }
  );
}

void runScriptAndExit(main);
