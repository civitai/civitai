import { PROVIDER_OPTIONS } from '@civitai/components-chat/core';
import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';

import { MintRefusedError, type TokenSource } from '../minter';
import { OrchestrationClient } from '../orchestration';
import { OrchestrationModels, refusalsAsAnswers } from '../orchestration-model';

const BASE = 'https://orchestration.example';
const FREE_MODEL = 'civitai/qwen3.8';
const PAID_MODEL = 'openai/gpt-6-luna';

interface Seen {
  path: string;
  authorization: string | null;
  tier: string | null;
  body: Record<string, unknown> | undefined;
}

/** Orchestration's chat completions and free-tier routes; answers 401 to any token in `rejected`. */
function fakeOrchestration(rejected = new Set<string>()) {
  const seen: Seen[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const authorization = headers.get('authorization');
    seen.push({
      path: url.pathname,
      authorization,
      tier: headers.get('x-civitai-tier'),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    if (rejected.has(authorization?.replace(/^Bearer /, '') ?? ''))
      return new Response('', { status: 401 });
    if (url.pathname === '/v2/consumer/free-tier')
      return Response.json({
        enabled: true,
        models: [
          {
            key: 'qwen3.8-chat',
            airs: [FREE_MODEL],
            remaining: 5,
            windows: [{ limit: 5, remaining: 5 }],
          },
        ],
      });
    if (url.pathname === '/v1/chat/completions')
      return Response.json({
        id: 'cmpl-1',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    return new Response('', { status: 404 });
  };
  return { seen, doFetch, chat: () => seen.filter((s) => s.path === '/v1/chat/completions') };
}

/** Tokens the way a run's grant mints them: numbered, so a fresh one is told apart from a cached one. */
function runTokens() {
  const asked: { runId: string; fresh: boolean }[] = [];
  let n = 0;
  const forRun =
    (runId: string): TokenSource =>
    async (purpose, options) => {
      asked.push({ runId, fresh: options?.fresh === true });
      return `${purpose}-${runId}-${++n}`;
    };
  return { asked, forRun };
}

function models(doFetch: typeof fetch, tokens: (runId: string) => TokenSource) {
  return new OrchestrationModels({
    baseUrl: BASE,
    orchestration: new OrchestrationClient(BASE, doFetch),
    tokens,
    fetch: doFetch,
  });
}

const context = (model: string, tier: 'auto' | 'free' | 'paid') => ({
  userId: 'u1',
  runId: 'r1',
  conversationId: 'c1',
  model,
  tier,
});

const ask = (model: ReturnType<OrchestrationModels['languageModel']>) =>
  generateText({ model, prompt: 'hi', maxRetries: 0, providerOptions: PROVIDER_OPTIONS });

describe('OrchestrationModels', () => {
  it('asks orchestration’s chat completions as the viewer, with the chat’s provider options, for the model the start named', async () => {
    const orchestration = fakeOrchestration();
    const tokens = runTokens();
    const result = await ask(
      models(orchestration.doFetch, tokens.forRun).languageModel(context(PAID_MODEL, 'auto'))
    );
    expect(result.text).toBe('Hello.');
    const [call] = orchestration.chat();
    expect(call!.authorization).toMatch(/^Bearer chat-r1-\d+$/);
    expect(call!.body).toMatchObject({
      model: PAID_MODEL,
      chat_template_kwargs: { enable_thinking: false },
    });
    // No free allowance for this model: paid, no free-tier header.
    expect(call!.tier).toBeNull();
    expect(tokens.asked.every((a) => a.runId === 'r1')).toBe(true);
  });

  it('sends a reply free while the model’s free allowance lasts, unless the viewer chose paid', async () => {
    const free = fakeOrchestration();
    await ask(models(free.doFetch, runTokens().forRun).languageModel(context(FREE_MODEL, 'auto')));
    expect(free.chat()[0]!.tier).toBe('free');

    const paid = fakeOrchestration();
    await ask(models(paid.doFetch, runTokens().forRun).languageModel(context(FREE_MODEL, 'paid')));
    expect(paid.chat()[0]!.tier).toBeNull();
  });

  it('never sends a free-only viewer’s reply paid', async () => {
    const orchestration = fakeOrchestration();
    const error = await ask(
      models(orchestration.doFetch, runTokens().forRun).languageModel(context(PAID_MODEL, 'free'))
    ).catch((e: unknown) => e);
    expect(String((error as Error).message)).toMatch(/no free replies/i);
    expect(orchestration.chat()).toEqual([]);
  });

  it('asks again with a freshly minted token after a 401', async () => {
    const tokens = runTokens();
    const first = 'chat-r1-1';
    const orchestration = fakeOrchestration(new Set([first]));
    // Paid: the free-tier read does not take the first token.
    const result = await ask(
      models(orchestration.doFetch, tokens.forRun).languageModel(context(PAID_MODEL, 'paid'))
    );
    expect(result.text).toBe('Hello.');
    expect(orchestration.chat().map((c) => c.authorization)).toEqual([
      `Bearer ${first}`,
      'Bearer chat-r1-2',
    ]);
    expect(tokens.asked.map((a) => a.fresh)).toEqual([false, true]);
  });

  it('ends the reply without asking orchestration when civitai will not mint (consent revoked)', async () => {
    const orchestration = fakeOrchestration();
    const refused: TokenSource = async () => {
      throw new MintRefusedError(
        'consent_required',
        'App Assistant is turned off for this account.',
        403
      );
    };
    const error = await ask(
      models(orchestration.doFetch, () => refused).languageModel(context(PAID_MODEL, 'paid'))
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 403 });
    expect(String((error as Error).message)).toMatch(/turned off/);
    expect(orchestration.chat()).toEqual([]);
  });

  it('answers each refused mint with a status the AI SDK retries only for an outage', async () => {
    for (const [code, status] of [
      ['consent_required', 403],
      ['invalid_grant', 400],
      ['refused', 403],
      ['unavailable', 503],
    ] as const) {
      const send = refusalsAsAnswers(async () => {
        throw new MintRefusedError(code, 'why', 401);
      });
      const response = await send('https://orchestration.example/v1/chat/completions');
      expect(response.status, code).toBe(status);
      expect(await response.json(), code).toEqual({ error: { message: 'why', code } });
    }
    await expect(
      refusalsAsAnswers(async () => {
        throw new TypeError('fetch failed');
      })('https://orchestration.example')
    ).rejects.toThrow('fetch failed');
  });
});
