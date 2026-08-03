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
      expect(res).toEqual({ reply: 'grounded reply' });
      expect(mockGetTextCompletion).toHaveBeenCalledTimes(1);
    }
  );
});

describe('agentReviewChat — request shape', () => {
  it('calls getTextCompletion with the model + a server-authored system-grounding message', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    mockGetTextCompletion.mockResolvedValue({
      content: 'Because buzz:read is used in wallet.js:10.',
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    const res = await agentReviewChat({
      publishRequestId: PUBREQ,
      messages: [{ role: 'user', content: 'why did you flag scope buzz:read?' }],
    });
    expect(res).toEqual({ reply: 'Because buzz:read is used in wallet.js:10.' });

    const call = mockGetTextCompletion.mock.calls[0][0];
    expect(call.model).toBe(AGENT_REVIEW_CHAT_MODEL);
    expect(call.temperature).toBe(0);
    expect(typeof call.maxTokens).toBe('number');
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
      await agentReviewChat({ publishRequestId: PUBREQ, messages: [{ role: 'user', content: 'hi' }] });
    } catch (e) {
      expect((e as Error).message).not.toContain('boom secret');
    }
  });
});
