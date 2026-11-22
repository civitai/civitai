import { parseArgs } from 'util';

import { dbRead } from '~/server/db/client';
import { transcriptReaderFor } from '~/server/services/app-assistant/session-transcripts';
import {
  buildSubmissionTrace,
  liveSubmissionTraceDeps,
} from '~/server/services/app-assistant/submission-trace.service';
import { conversationsChoosing } from '~/server/services/app-assistant/trace-backfill';
import { runScriptAndExit } from './lib/run-as-script';

/**
 * Backfill App Assistant session traces for publish requests that predate session tracing (or were
 * submitted while its flag was off): for each request with no trace, find the SUBMITTER's App
 * Assistant chats whose `create_app` / `use_open_app` / `wake_app` result named the request's slug,
 * and freeze them exactly as a submit does (`buildSubmissionTrace`, a trace row per request).
 *
 *   pnpm run tsscript scripts/backfill-app-assistant-traces.ts [--apply] [--since 2026-10-01]
 *     [--slug <slug>] [--request <publishRequestId>] [--limit 50] [--max-pages 20]
 *
 * Modes:
 *   (default)  Dry run: reads requests and the submitters' chats, prints what it would trace for
 *              each, writes nothing.
 *   --apply    Also fetches each request's bundle and writes its snapshots and trace row.
 *
 * Idempotent: a request that already has a trace is skipped (and the trace's unique key on the
 * request refuses a second row). Safe to stop and re-run.
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
    },
  });
  const limit = Math.max(1, Math.min(500, Number(values.limit)));
  const maxPages = Math.max(1, Math.min(200, Number(values['max-pages'])));

  const requests = await dbRead.appBlockPublishRequest.findMany({
    where: {
      assistantTrace: null,
      ...(values.request ? { id: values.request } : {}),
      ...(values.slug ? { slug: values.slug } : {}),
      ...(values.since ? { submittedAt: { gte: new Date(values.since) } } : {}),
    },
    orderBy: { submittedAt: 'desc' },
    take: limit,
    select: { id: true, slug: true, submittedByUserId: true, bundleKey: true },
  });
  console.log(`${values.apply ? 'APPLY' : 'DRY RUN'}: ${requests.length} requests with no trace`);

  // One listing of each submitter's chats, shared by their requests.
  const chatsByUser = new Map<number, { conversationId: string }[] | string>();
  const deps = values.apply ? await liveSubmissionTraceDeps() : null;
  let traced = 0;
  for (const request of requests) {
    let chats = chatsByUser.get(request.submittedByUserId);
    if (chats === undefined) {
      const reader = await transcriptReaderFor(request.submittedByUserId);
      if ('refused' in reader) chats = reader.refused;
      else {
        const all: { conversationId: string }[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < maxPages; page++) {
          const listed = await reader.list(cursor);
          all.push(...listed.items);
          if (!listed.next) break;
          cursor = listed.next;
        }
        chats = all;
      }
      chatsByUser.set(request.submittedByUserId, chats);
    }
    if (typeof chats === 'string') {
      console.log(
        `${request.id} ${request.slug} user ${request.submittedByUserId}: skipped (${chats})`
      );
      continue;
    }
    const conversationIds = conversationsChoosing(chats, request.slug);
    console.log(
      `${request.id} ${request.slug} user ${request.submittedByUserId}: ${conversationIds.length} chats`
    );
    if (!deps) continue;
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
    const result = await buildSubmissionTrace(
      {
        publishRequestId: request.id,
        slug: request.slug,
        submittedByUserId: request.submittedByUserId,
        bundleBuffer,
        conversationIds,
      },
      deps
    );
    if (result) traced++;
    console.log(
      `  ${result ? 'traced' : 'NOT written'}${
        result?.snapshotError ? `: ${result.snapshotError}` : ''
      }`
    );
  }
  if (values.apply) console.log(`traced ${traced} of ${requests.length}`);
}

void runScriptAndExit(main);
