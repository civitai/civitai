import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks P3) — in-modal chat proxy service.
 *
 * Covers agentReviewChat against a mocked report read + a stubbed in-cluster
 * fetch:
 *   - report missing → PRECONDITION_FAILED, gateway NOT called
 *   - report failed / torn-down → PRECONDITION_FAILED (pod not up)
 *   - happy path (complete): returns the reply, POSTs to the right
 *     `…svc.cluster.local:18789/v1/chat/completions` URL with the correct DERIVED
 *     bearer and a server-authored system-context message present
 *   - running / cost-capped are also reachable (pod up)
 *   - gateway non-200 → clean BAD_GATEWAY TRPCError, no 500, no secret leak
 *   - gateway throws (timeout/unreachable) → clean BAD_GATEWAY
 *   - reasoning-model fallback (content null → reasoning used)
 *
 * The DERIVED bearer/token helpers are NOT mocked — the test uses the real
 * `deriveAgentGatewayBearer` (same module the service calls) against an injected
 * NEXTAUTH_SECRET, so the asserted bearer is the true derivation.
 */

const { mockEnv, mockGetAgentReport } = vi.hoisted(() => ({
  mockEnv: { APPS_KUBE_NAMESPACE: 'civitai-apps' } as Record<string, unknown>,
  mockGetAgentReport: vi.fn(),
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

import {
  agentReviewChat,
  agentReviewName,
  AGENT_REVIEW_CHAT_MODEL,
} from '~/server/services/blocks/agent-review.service';
import { deriveAgentGatewayBearer } from '~/server/services/blocks/review-session';

const SECRET = 'test-nextauth-secret-dddddddddddddddddddd';
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

type Captured = { url: string; init: RequestInit };
let captured: Captured[] = [];

function stubFetch(
  responder: () => { ok: boolean; status: number; json?: () => Promise<unknown> }
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, init });
      const r = responder();
      return {
        ok: r.ok,
        status: r.status,
        json: r.json ?? (async () => ({})),
        text: async () => '',
      } as unknown as Response;
    })
  );
}

function okResponse(message: Record<string, unknown>) {
  return () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message }] }),
  });
}

beforeEach(() => {
  captured = [];
  process.env.NEXTAUTH_SECRET = SECRET;
  mockEnv.APPS_KUBE_NAMESPACE = 'civitai-apps';
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('agentReviewChat — pod-availability guard', () => {
  it('rejects PRECONDITION_FAILED when there is no report (gateway not called)', async () => {
    mockGetAgentReport.mockResolvedValue(null);
    stubFetch(okResponse({ content: 'x' }));
    await expect(
      agentReviewChat({ publishRequestId: PUBREQ, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(captured.length).toBe(0);
  });

  it('rejects PRECONDITION_FAILED when the report is failed (pod not up)', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT({ status: 'failed' }));
    stubFetch(okResponse({ content: 'x' }));
    await expect(
      agentReviewChat({ publishRequestId: PUBREQ, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(captured.length).toBe(0);
  });

  it('rejects PRECONDITION_FAILED when the report is torn-down', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT({ status: 'torn-down' }));
    stubFetch(okResponse({ content: 'x' }));
    await expect(
      agentReviewChat({ publishRequestId: PUBREQ, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it.each(['running', 'complete', 'cost-capped'])(
    'reaches the gateway when the report status is %s (pod up)',
    async (status) => {
      mockGetAgentReport.mockResolvedValue(REPORT({ status }));
      stubFetch(okResponse({ content: 'ok' }));
      const res = await agentReviewChat({
        publishRequestId: PUBREQ,
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(res).toEqual({ reply: 'ok' });
      expect(captured.length).toBe(1);
    }
  );
});

describe('agentReviewChat — request shape', () => {
  it('POSTs to the in-cluster gateway URL with the derived bearer + a system context message', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    stubFetch(okResponse({ content: 'Because buzz:read is used in wallet.js:10.' }));

    const res = await agentReviewChat({
      publishRequestId: PUBREQ,
      messages: [{ role: 'user', content: 'why did you flag scope buzz:read?' }],
    });
    expect(res).toEqual({ reply: 'Because buzz:read is used in wallet.js:10.' });

    const call = captured[0];
    // Exact in-cluster gateway URL.
    expect(call.url).toBe(
      `http://${agentReviewName(PUBREQ)}.civitai-apps.svc.cluster.local:18789/v1/chat/completions`
    );
    // Method + correct DERIVED bearer (recomputed from the same secret).
    expect(String(call.init.method)).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Bearer ${deriveAgentGatewayBearer(PUBREQ, { secret: SECRET })}`
    );

    const body = JSON.parse(String(call.init.body));
    expect(body.model).toBe(AGENT_REVIEW_CHAT_MODEL);
    expect(body.temperature).toBe(0);
    expect(typeof body.max_tokens).toBe('number');
    // A server-authored SYSTEM message is prepended, carrying the report summary
    // + the adversarial-data framing; the client's user turn follows.
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('ADVERSARIAL DATA');
    expect(body.messages[0].content).toContain('scope concern on buzz:read'); // from summaryMd
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: 'why did you flag scope buzz:read?',
    });
  });

  it('does NOT let the client inject a system role — only user/assistant turns pass through', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    stubFetch(okResponse({ content: 'ok' }));
    await agentReviewChat({
      publishRequestId: PUBREQ,
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    });
    const body = JSON.parse(String(captured[0].init.body));
    // Exactly one system message (the server's), at index 0.
    expect(body.messages.filter((m: { role: string }) => m.role === 'system')).toHaveLength(1);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages.slice(1).map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });
});

describe('agentReviewChat — failure containment (no 500, no leak)', () => {
  it('a non-200 gateway response → clean BAD_GATEWAY, message does not leak the bearer/URL', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    stubFetch(() => ({ ok: false, status: 502 }));
    await expect(
      agentReviewChat({ publishRequestId: PUBREQ, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'BAD_GATEWAY', message: 'the review agent did not respond' });

    // The thrown message must not contain the derived bearer nor the internal host.
    try {
      await agentReviewChat({ publishRequestId: PUBREQ, messages: [{ role: 'user', content: 'hi' }] });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('svc.cluster.local');
      expect(msg).not.toContain(deriveAgentGatewayBearer(PUBREQ, { secret: SECRET }));
    }
  });

  it('a fetch that throws (timeout/unreachable) → clean BAD_GATEWAY', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('AbortError: The operation was aborted');
      })
    );
    await expect(
      agentReviewChat({ publishRequestId: PUBREQ, messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ code: 'BAD_GATEWAY', message: 'the review agent did not respond' });
  });
});

describe('agentReviewChat — reasoning-model fallback', () => {
  it('uses choices[0].message.reasoning when content is null', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    stubFetch(okResponse({ content: null, reasoning: 'reasoned answer citing auth.js:42' }));
    const res = await agentReviewChat({
      publishRequestId: PUBREQ,
      messages: [{ role: 'user', content: 'why?' }],
    });
    expect(res).toEqual({ reply: 'reasoned answer citing auth.js:42' });
  });

  it('returns an empty string when neither content nor reasoning is present', async () => {
    mockGetAgentReport.mockResolvedValue(REPORT());
    stubFetch(okResponse({}));
    const res = await agentReviewChat({
      publishRequestId: PUBREQ,
      messages: [{ role: 'user', content: 'why?' }],
    });
    expect(res).toEqual({ reply: '' });
  });
});
