import { describe, expect, it, vi } from 'vitest';
import type { JWK } from 'jose';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import vectors from './fixtures/task-router-tickets.json';
import type { TaskRouterConfig } from '~/server/services/blocks/task-router.service';
import {
  matchTask,
  TaskTicketError,
  verifyTaskTicket,
} from '~/server/services/blocks/task-router.service';

const vectorJwks = createLocalJWKSet(vectors.jwks as { keys: JWK[] });
const verifyOpts = (over: Partial<Parameters<typeof verifyTaskTicket>[1]> = {}) => ({
  jwks: vectorJwks,
  audience: vectors.audience,
  budget: vectors.budget,
  user: vectors.user,
  callbackOrigin: vectors.callbackOrigin,
  ...over,
});
const vectorCase = (name: string) => {
  const found = vectors.cases.find((c) => c.name === name);
  if (!found) throw new Error(`no vector ${name}`);
  return found;
};

describe('verifyTaskTicket against the router repo vectors', () => {
  for (const c of vectors.cases) {
    it(`${c.expect}s the ${c.name} ticket`, async () => {
      const result = verifyTaskTicket(c.ticket, verifyOpts({ currentDate: new Date(c.verifyAt) }));
      if (c.expect === 'accept') await expect(result).resolves.toBeTruthy();
      else await expect(result).rejects.toBeInstanceOf(TaskTicketError);
    });
  }

  it('returns the steps, with their references, the router tags and the callbacks', async () => {
    const chain = vectorCase('valid_chain');
    const ticket = await verifyTaskTicket(
      chain.ticket,
      verifyOpts({ currentDate: new Date(chain.verifyAt) })
    );
    expect(ticket.taskId).toBe(chain.sub);
    expect(ticket.steps.map((step) => step.name)).toEqual(['gen', 'cut']);
    expect(ticket.steps[1].input.image).toEqual({ $ref: 'gen', path: 'output.images[0].url' });
    expect(ticket.tags).toEqual(['task:chain', `tr:${chain.sub}`]);
    expect(ticket.callbacks).toHaveLength(1);
  });
});

// Checks the vectors do not cover, on tickets this file signs itself.
describe('verifyTaskTicket on locally signed tickets', () => {
  const NOW = new Date('2026-10-26T20:00:30Z');
  const keys = generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const jwks = keys.then(async ({ publicKey }) =>
    createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'local', alg: 'EdDSA' }] })
  );

  const claims = (over: Record<string, unknown> = {}, workflow: Record<string, unknown> = {}) => ({
    v: 2,
    provider: 'civitai-orchestrator',
    steps: [{ name: 's0', goal: 'image.edit@1', ability: 'orch.x', via: 'rank' }],
    budget: vectors.budget,
    quote: { amount: 8, currency: 'buzz' },
    user: vectors.user,
    request: {
      kind: 'orchestrator.workflow',
      workflow: {
        steps: [{ $type: 'imageGen', input: { prompt: 'p' } }],
        tags: ['task:image.edit@1', 'tr:tsk_local'],
        metadata: { taskRouter: { v: 2, taskId: 'tsk_local' } },
        callbacks: [{ url: `${vectors.callbackOrigin}/v1/callbacks/x`, type: ['workflow:*'] }],
        ...workflow,
      },
    },
    ...over,
  });
  async function sign(payload: Record<string, unknown>) {
    const { privateKey } = await keys;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'local' })
      .setIssuer('task-router')
      .setAudience(vectors.audience)
      .setSubject('tsk_local')
      .setJti('tsk_local')
      .setIssuedAt(Math.floor(NOW.getTime() / 1000))
      .setExpirationTime(Math.floor(NOW.getTime() / 1000) + 120)
      .sign(privateKey);
  }
  const verify = async (payload: Record<string, unknown>) =>
    verifyTaskTicket(await sign(payload), verifyOpts({ jwks: await jwks, currentDate: NOW }));

  it('accepts the baseline ticket', async () => {
    await expect(verify(claims())).resolves.toMatchObject({ taskId: 'tsk_local' });
  });

  it.each([
    [
      'a budget other than the one sent',
      claims({ budget: { amount: 50, currency: 'buzz' } }),
      /budget/,
    ],
    ['a quote above the budget', claims({ quote: { amount: 21, currency: 'buzz' } }), /quote/],
    ['another user', claims({ user: 'u_someone_else' }), /user/],
    ['a version-1 ticket', claims({ v: 1 }), /version/],
    [
      'nine steps',
      claims({}, { steps: Array.from({ length: 9 }, () => ({ $type: 'imageGen', input: {} })) }),
      /1 to 8 steps/,
    ],
    ['a tag outside the router shapes', claims({}, { tags: ['app-block:app_other'] }), /tag/],
    [
      'a callback on a host that only starts with the router origin',
      claims(
        {},
        { callbacks: [{ url: `${vectors.callbackOrigin}.attacker.example/x`, type: [] }] }
      ),
      /callback/,
    ],
  ])('rejects %s', async (_name, payload, message) => {
    await expect(verify(payload)).rejects.toThrow(message);
  });
});

describe('matchTask', () => {
  const config: TaskRouterConfig = {
    url: 'https://router.example.invalid',
    partyKey: 'party-key',
    partyId: 'civitai-app-blocks',
    callbackOrigin: vectors.callbackOrigin,
    appAllowlist: [],
  };
  const request = {
    task: 'image.edit@1',
    input: {},
    budget: { amount: 20, currency: 'buzz' },
    requester: { app: 'app_1', user: 'u_1' },
  };
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('sends the party key and returns the match', async () => {
    const fetchImpl = respond(200, {
      status: 'matched',
      taskId: 'tsk_1',
      resolvedAs: [
        {
          step: 's0',
          goal: 'image.edit@1',
          tier: 'standard',
          ability: 'a',
          provider: 'p',
          via: 'sticky',
          assignment: { event: 'kept' },
        },
      ],
      quote: { amount: 8, currency: 'buzz' },
      ticket: 'jws',
    });
    const result = await matchTask(config, request, fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: true, match: { taskId: 'tsk_1', ticket: 'jws' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe('https://router.example.invalid/v1/tasks/match');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer party-key');
  });

  it('passes a router refusal through by its code', async () => {
    const fetchImpl = respond(422, { error: 'tier_unavailable', message: 'no best tier' });
    await expect(matchTask(config, request, fetchImpl as unknown as typeof fetch)).resolves.toEqual(
      {
        ok: false,
        code: 'tier_unavailable',
        message: 'no best tier',
      }
    );
  });

  it('returns an off-menu reply as not_yet, with its closest items', async () => {
    const fetchImpl = respond(200, { status: 'not_yet', demandId: 'dem_1', closest: [] });
    await expect(matchTask(config, request, fetchImpl as unknown as typeof fetch)).resolves.toEqual(
      { ok: true, notYet: { status: 'not_yet', demandId: 'dem_1', closest: [] } }
    );
  });

  it('reports an unknown router error or an unreachable router as task-unavailable', async () => {
    const odd = respond(500, { error: 'database_on_fire' });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    for (const fetchImpl of [odd, down]) {
      await expect(
        matchTask(config, request, fetchImpl as unknown as typeof fetch)
      ).resolves.toMatchObject({ ok: false, code: 'task-unavailable' });
    }
  });
});
