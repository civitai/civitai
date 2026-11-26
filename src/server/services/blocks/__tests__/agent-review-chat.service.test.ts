import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks P3) — in-modal chat, STATELESS + report-grounded.
 *
 * Chat was DECOUPLED from the live agent pod (2026-07-27): it no longer proxies to
 * the pod's in-cluster gateway (:18789). It is now a stateless civitai→LLM call
 * (openrouter.getTextCompletion) grounded on the PERSISTED report, which unlocked
 * rendering the analysis workload as an ephemeral Job.
 *
 * Covers agentReviewChat against a mocked report read + a mocked OpenRouter client:
 *   - report missing → PRECONDITION_FAILED, LLM NOT called
 *   - report torn-down → PRECONDITION_FAILED (review closed), LLM NOT called
 *   - running / complete / cost-capped / failed → groundable (LLM called)
 *   - happy path: returns the reply, calls getTextCompletion with the right model +
 *     a server-authored system-grounding message (+ NO client system injection)
 *   - LLM throws → clean BAD_GATEWAY (no leak)
 *   - a reply cut at the token cap comes back `truncated`, and every reply fits the
 *     history cap the next turn re-sends it under
 */

const { mockEnv, mockGetAgentReport, mockGetTextCompletion } = vi.hoisted(() => ({
  mockEnv: { APPS_KUBE_NAMESPACE: 'civitai-apps' } as Record<string, unknown>,
  mockGetAgentReport: vi.fn(),
  mockGetTextCompletion: vi.fn(),
}));

vi.mock('~/env/server', () => ({ env: mockEnv }));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  getDp1Target: vi.fn(),
  k8sFetch: vi.fn(),
  unwrap: vi.fn(),
}));
vi.mock('~/server/services/blocks/app-review-report.service', () => ({
  getAgentReport: mockGetAgentReport,
}));
// The OpenRouter client civitai now calls directly for the grounded reply.
// Keep the real `AI_MODELS` export (drift-proof: agent-review.service reads
// `AI_MODELS.CLAUDE_HAIKU` at module load for AGENT_REVIEW_CHAT_MODEL). Only the
// live `openrouter` client is stubbed. `importOriginal` doesn't construct a real
// client here — `~/env/server` is mocked with no OPENROUTER_API_KEY, so the
// module-load `createOpenRouterClient()` guard is skipped.
vi.mock('~/server/services/ai/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/services/ai/openrouter')>()),
  openrouter: { getTextCompletion: mockGetTextCompletion },
}));

import {
  agentReviewChat,
  AGENT_REVIEW_CHAT_MODEL,
} from '~/server/services/blocks/agent-review.service';
import { agentReviewChatSchema } from '~/server/schema/blocks/publish-request.schema';

const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';

const REPORT = (over: Record<string, unknown> = {}) => ({
  id: 'arar_1',
  publishRequestId: PUBREQ,
  slug: 'my-app',
  version: '1.2.0',
  status: 'complete',
  summaryMd: 'Overall reasonable with a scope concern on buzz:read.',
  scopeVerdicts: { scopes: [{ declared: 'buzz:read:self', used: 'yes' }] },
  codeReview: { findings: [] },
  securityAudit: { findings: [] },
  ...over,
});

beforeEach(() => {
  mockEnv.APPS_KUBE_NAMESPACE = 'civitai-apps';
  vi.clearAllMocks();
  mockGetTextCompletion.mockResolvedValue({
    content: 'grounded reply',
    usage: { promptTokens: 1, completionTokens: 1 },
    finishReason: 'stop',
  });
});
afterEach(() => vi.restoreAllMocks());

describe('agentReviewChat — groundability guard', () => {
  it('rejects PRECONDITION_FAILED when there is no report (LLM not called)', async () => {
    mockGetAgentReport.mockResolvedValue(null);
    await expect(
      agentReviewChat({ publishRequestId: PUBREQ, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockGetTextCompletion).not.toHaveBeenCalled();
  });

  it('rejects PRECONDITION_FAILED when the report is torn-down (review closed)', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT({ status: 'torn-down' }));
    await expect(
      agentReviewChat({ publishRequestId: PUBREQ, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockGetTextCompletion).not.toHaveBeenCalled();
  });

  it.each(['running', 'complete', 'cost-capped', 'failed'])(
    'grounds a reply when the report status is %s',
    async (status) => {
      mockGetAgentReport.mockResolvedValue(REPORT({ status }));
      const res = await agentReviewChat({
        publishRequestId: PUBREQ,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res).toEqual({ reply: 'grounded reply', truncated: false });
      expect(mockGetTextCompletion).toHaveBeenCalledTimes(1);
    }
  );
});

describe('agentReviewChat — which report it grounds on', () => {
  it('grounds on the run the moderator is viewing, looked up within the request', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT({ id: 'arar_old', summaryMd: 'the OLD run' }));
    await agentReviewChat({
      publishRequestId: PUBREQ,
      reportId: 'arar_old',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(mockGetAgentReport).toHaveBeenCalledWith(PUBREQ, 'arar_old');
    expect(mockGetTextCompletion.mock.calls[0][0].messages[0].content).toContain('the OLD run');
  });

  it('with no reportId it grounds on the latest run, as before', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    await agentReviewChat({
      publishRequestId: PUBREQ,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(mockGetAgentReport).toHaveBeenCalledWith(PUBREQ, undefined);
  });
});

describe('agentReviewChat — request shape', () => {
  it('calls getTextCompletion with the model + a server-authored system-grounding message', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    mockGetTextCompletion.mockResolvedValue({
      content: 'Because buzz:read is used in wallet.js:10.',
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    });

    const res = await agentReviewChat({
      publishRequestId: PUBREQ,
      messages: [{ role: 'user', content: 'why did you flag scope buzz:read?' }],
    });
    expect(res).toEqual({ reply: 'Because buzz:read is used in wallet.js:10.', truncated: false });

    const call = mockGetTextCompletion.mock.calls[0][0];
    expect(call.model).toBe(AGENT_REVIEW_CHAT_MODEL);
    // Pinned literal, not the constant: the previous id was retired by OpenRouter and every
    // call 404'd while the line above stayed green.
    expect(call.model).toBe('anthropic/claude-haiku-5.5');
    expect(call.temperature).toBe(0);
    // Pinned literal: at 1024 a detailed answer was cut off mid-sentence.
    expect(call.maxTokens).toBe(4096);
    // A server-authored SYSTEM message is prepended, carrying the report summary
    // + the adversarial-data framing; the client's user turn follows.
    expect(call.messages[0].role).toBe('system');
    expect(call.messages[0].content).toContain('ADVERSARIAL DATA');
    expect(call.messages[0].content).toContain('scope concern on buzz:read'); // from summaryMd
    // No live /bundle access is claimed in the stateless grounding message.
    expect(call.messages[0].content).not.toContain('/bundle');
    expect(call.messages[1]).toEqual({
      role: 'user',
      content: 'why did you flag scope buzz:read?',
    });
  });

  it('does NOT let the client inject a system role — only user/assistant turns pass through', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    await agentReviewChat({
      publishRequestId: PUBREQ,
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    });
    const call = mockGetTextCompletion.mock.calls[0][0];
    // Exactly one system message (the server's), at index 0.
    expect(call.messages.filter((m: { role: string }) => m.role === 'system')).toHaveLength(1);
    expect(call.messages[0].role).toBe('system');
    expect(call.messages.slice(1).map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });
});

describe('agentReviewChat — failure containment (no 500, no leak)', () => {
  it('an LLM error → clean BAD_GATEWAY, message does not leak internals', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    mockGetTextCompletion.mockRejectedValue(new Error('Civitai LLM error 500: boom secret'));
    await expect(
      agentReviewChat({ publishRequestId: PUBREQ, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'BAD_GATEWAY', message: 'the review agent did not respond' });

    try {
      await agentReviewChat({
        publishRequestId: PUBREQ,
        messages: [{ role: 'user', content: 'hi' }],
      });
    } catch (e) {
      expect((e as Error).message).not.toContain('boom secret');
    }
  });
});

describe('agentReviewChat — a reply that does not fit', () => {
  const ask = () =>
    agentReviewChat({ publishRequestId: PUBREQ, messages: [{ role: 'user', content: 'hi' }] });

  it('a reply the model stopped at the token cap comes back truncated', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    mockGetTextCompletion.mockResolvedValue({
      content: 'The first finding is in wallet.js:10, and the second',
      usage: { promptTokens: 1, completionTokens: 4096 },
      finishReason: 'length',
    });
    await expect(ask()).resolves.toEqual({
      reply: 'The first finding is in wallet.js:10, and the second',
      truncated: true,
    });
  });

  it('a reply the model finished is not truncated', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    await expect(ask()).resolves.toEqual({ reply: 'grounded reply', truncated: false });
  });

  it('🔴 any reply can be re-sent as history on the next turn without failing validation', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    // Longer than the 32,000-character history cap, and not a multiple of it.
    const long = 'wallet.js:10 '.repeat(3000); // 39,000 characters
    mockGetTextCompletion.mockResolvedValue({
      content: long,
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    });
    const res = await ask();
    expect(res.truncated).toBe(true);
    expect(res.reply).toHaveLength(32_000);
    expect(long.startsWith(res.reply)).toBe(true);

    // The seam: the reply goes straight back through the router's input schema.
    const next = agentReviewChatSchema.safeParse({
      publishRequestId: PUBREQ,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: res.reply },
        { role: 'user', content: 'continue' },
      ],
    });
    expect(next.success).toBe(true);
  });
});
