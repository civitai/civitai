import type { NextApiRequest, NextApiResponse } from 'next';
import { TRPCError } from '@trpc/server';
import { randomUUID } from 'crypto';
import { env } from '~/env/server';
import { logToAxiom, safeError } from '~/server/logging/client';
import {
  assertAgentReviewAccess,
  isAgentReviewLaneEnabled,
} from '~/server/services/blocks/agent-review-lane';
import {
  buildReviewChatSystemMessage,
  CHAT_GROUNDABLE_STATUSES,
  createReviewChatTools,
  parseReviewChatRequest,
  runReviewChat,
  SSE_DONE,
  sseChunk,
  sseError,
  type BundleFile,
  type ReviewChatReport,
} from '~/server/services/blocks/agent-review-chat.service';
import type { BundleLineDiff } from '~/server/services/blocks/publish-request.service';
import { outboundFetch } from '~/server/utils/fetch-timeout';
import {
  defineModeratorStreamEndpoint,
  type ModeratorStreamCtx,
} from '~/server/utils/moderator-endpoint';
import { agentReviewLaneFor } from '~/shared/constants/connect-agent-review.constants';
import { REVIEW_AGENT_CHAT_HEADERS } from '~/shared/constants/review-agent-chat.constants';
import type { SessionUser } from '~/types/session';

/**
 * POST /api/mod/apps/review-agent/v1/chat/completions — the review agent chat's model endpoint.
 *
 * The `<civitai-chat>` element on the review page sends OpenAI chat-completions requests here
 * (`backend.url = /api/mod/apps/review-agent`). On EVERY request: a moderator
 * (`defineModeratorStreamEndpoint`, the rule every moderator endpoint applies), the App Blocks flag for them, and the agent review lane of the publish
 * request named by the `x-review-publish-request-id` header (`assertAgentReviewAccess`, the gate
 * every agent-review procedure runs). Then the server builds the prompt from the persisted report,
 * runs the model with read-only tools bound to that request, and streams the reply back as SSE.
 *
 * Holds the OpenRouter key; the page never sees it. No Buzz is charged and nothing is stored: the
 * conversation lives in the page for its session.
 */

export type ReviewAgentChatDeps = {
  isAppBlocksEnabled: (opts: { user: SessionUser }) => Promise<boolean>;
  isLaneEnabled: typeof isAgentReviewLaneEnabled;
  getReport: (publishRequestId: string, reportId?: string) => Promise<ReviewChatReport | null>;
  loadFiles: (publishRequestId: string) => Promise<BundleFile[]>;
  loadDiff: (publishRequestId: string) => Promise<BundleLineDiff>;
  fetch: (url: string, init: RequestInit & { timeoutMs: number }) => Promise<Response>;
  apiKey: () => string | undefined;
};

const defaultDeps: ReviewAgentChatDeps = {
  isAppBlocksEnabled: async (opts) =>
    (await import('~/server/services/app-blocks-flag')).isAppBlocksEnabled(opts),
  isLaneEnabled: isAgentReviewLaneEnabled,
  getReport: async (publishRequestId, reportId) =>
    (await import('~/server/services/blocks/app-review-report.service')).getAgentReport(
      publishRequestId,
      reportId
    ),
  loadFiles: async (publishRequestId) => {
    const { getPublishRequestBundleFiles, isBinaryBundleFile } = await import(
      '~/server/services/blocks/publish-request.service'
    );
    const files = await getPublishRequestBundleFiles({ publishRequestId });
    return files.map((f) => ({ ...f, binary: isBinaryBundleFile(f.path, f.content) }));
  },
  loadDiff: async (publishRequestId) =>
    (await import('~/server/services/blocks/publish-request.service')).getPublishRequestDiff({
      publishRequestId,
    }),
  fetch: outboundFetch,
  apiKey: () => env.OPENROUTER_API_KEY,
};

/** A publish-request or report id, as the review page holds them. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

function header(req: NextApiRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function refuse(res: NextApiResponse, status: number, message: string) {
  return res.status(status).json({ error: { message } });
}

/** The handler behind the moderator gate; `deps` is how a test passes the flags, data and model. */
export function reviewAgentChat(deps: ReviewAgentChatDeps) {
  return async function handle({ actor, req, res }: ModeratorStreamCtx) {
    const publishRequestId = header(req, REVIEW_AGENT_CHAT_HEADERS.publishRequestId);
    const reportId = header(req, REVIEW_AGENT_CHAT_HEADERS.reportId) || undefined;
    if (!publishRequestId || !ID.test(publishRequestId) || (reportId && !ID.test(reportId)))
      return refuse(res, 400, 'The chat does not name a publish request.');

    if (!(await deps.isAppBlocksEnabled({ user: actor })))
      return refuse(res, 403, 'Apps are not enabled');
    try {
      await assertAgentReviewAccess(actor, publishRequestId, deps.isLaneEnabled);
    } catch (err) {
      if (err instanceof TRPCError) return refuse(res, 403, err.message);
      throw err;
    }

    const parsed = parseReviewChatRequest(req.body);
    if (!parsed.ok) return refuse(res, parsed.refusal.status, parsed.refusal.message);
    const request = parsed.value;

    // Naming the chat is the element's one request without `stream`. Answered without a model
    // call: an empty title keeps the chat's first-message title.
    if (!request.stream) {
      return res.status(200).json({
        id: `revchat-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: request.modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      });
    }

    const report = await deps.getReport(publishRequestId, reportId);
    if (!report || !CHAT_GROUNDABLE_STATUSES.has(report.status))
      return refuse(res, 409, 'The review agent has no report to answer from for this review.');

    const apiKey = deps.apiKey();
    if (!apiKey) return refuse(res, 503, 'The review agent is not available right now.');

    // The connect lane reviews an OAuth listing: there is no hosted bundle to read.
    const hasSource = agentReviewLaneFor(publishRequestId) === 'onsite';
    const tools = createReviewChatTools({
      report,
      loadFiles: hasSource ? () => deps.loadFiles(publishRequestId) : null,
      loadDiff: hasSource ? () => deps.loadDiff(publishRequestId) : null,
    });

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const id = `revchat-${randomUUID()}`;
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
    let first = true;
    try {
      const finish = await runReviewChat({
        request,
        systemMessage: buildReviewChatSystemMessage(report, { hasSource }),
        tools,
        apiKey,
        fetch: deps.fetch,
        signal: controller.signal,
        onText: (text) => {
          res.write(
            sseChunk(
              id,
              request.modelId,
              first ? { role: 'assistant', content: text } : { content: text }
            )
          );
          first = false;
        },
      });
      res.write(sseChunk(id, request.modelId, {}, finish));
      res.write(SSE_DONE);
    } catch (err) {
      if (!controller.signal.aborted) {
        logToAxiom({
          name: 'app-blocks.review.agent-chat',
          type: 'warning',
          message: 'review agent chat reply failed',
          error: safeError(err),
        });
        res.write(sseError('The review agent did not respond. Try again.'));
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  };
}

export default defineModeratorStreamEndpoint(reviewAgentChat(defaultDeps));
