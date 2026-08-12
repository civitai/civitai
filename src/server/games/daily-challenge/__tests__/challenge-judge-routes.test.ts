import { ChatError } from '@openrouter/sdk/models/errors';
import { describe, expect, it } from 'vitest';
import {
  isContentRefusal,
  JUDGE_ROUTES,
  PERMISSIVE_JUDGE,
  pickJudge,
} from '~/server/games/daily-challenge/challenge-judge-routes';
import { MODEL_BUZZ_RATES } from '~/server/games/daily-challenge/generative-content';

describe('pickJudge', () => {
  it('sends SFW pairs to the cheap route and adult pairs to the permissive one', () => {
    expect(pickJudge(1)).toBe(JUDGE_ROUTES[0].model);
    expect(pickJudge(4)).toBe(JUDGE_ROUTES[0].model);
    expect(pickJudge(8)).toBe(PERMISSIVE_JUDGE);
    expect(pickJudge(32)).toBe(PERMISSIVE_JUDGE);
  });

  it('falls off the end of the table to the permissive judge rather than returning nothing', () => {
    expect(pickJudge(1024)).toBe(PERMISSIVE_JUDGE);
  });

  it('prices every routed model — an unrated one silently reads as 0 spend', () => {
    for (const route of JUDGE_ROUTES) expect(MODEL_BUZZ_RATES[route.model]).toBeDefined();
  });

  it('keeps the widest route last, so a refusal has somewhere to go', () => {
    const ceilings = JUDGE_ROUTES.map((route) => route.maxNsfwLevel);
    expect([...ceilings].sort((a, b) => a - b)).toEqual(ceilings);
    expect(PERMISSIVE_JUDGE).toBe(JUDGE_ROUTES[JUDGE_ROUTES.length - 1].model);
  });
});

// The REAL error class, not a hand-written stand-in. The previous fixture here was
// `new Error('data_inspection_failed')`, which the regex matched and the live provider never
// produces: a ChatError's `.message` is `error.message` from the JSON envelope, which for a
// refusal is the generic "Provider returned error". Building the genuine article means the
// fixture cannot drift from the SDK — if a future version moves the body, this test moves with it.
function chatErrorFrom(rawBody: string, envelopeMessage = 'Provider returned error') {
  return new ChatError(
    {
      error: { message: envelopeMessage, code: 400 },
      request$: new Request('https://openrouter.ai/api/v1/chat/completions'),
      response$: new Response(rawBody, { status: 400 }),
      body$: rawBody,
    } as never,
    {
      request: new Request('https://openrouter.ai/api/v1/chat/completions'),
      response: new Response(rawBody, { status: 400 }),
      body: rawBody,
    }
  );
}

// Captured from the live run that exposed this: an nsfwLevel-16 image forced through qwen.
const LIVE_REFUSAL_BODY = JSON.stringify({
  error: {
    message: 'Provider returned error',
    code: 400,
    metadata: {
      raw: 'data: {"error":{"code":"data_inspection_failed","param":"","message":"Input image data may contain inappropriate content."}}',
      provider_name: 'Alibaba',
    },
  },
});

describe('isContentRefusal', () => {
  it('recognises the REAL provider refusal, whose message says only "Provider returned error"', () => {
    const error = chatErrorFrom(LIVE_REFUSAL_BODY);

    // The precondition that made the old fixture vacuous: nothing useful is on `.message`.
    expect(error.message).toBe('Provider returned error');
    expect(isContentRefusal(error.message)).toBe(false);

    expect(isContentRefusal(error)).toBe(true);
  });

  it('still finds it when only the raw body carries the token', () => {
    expect(isContentRefusal(chatErrorFrom('upstream said content_policy violation'))).toBe(true);
    expect(
      isContentRefusal(chatErrorFrom('Input image data may contain inappropriate content.'))
    ).toBe(true);
  });

  it('does not mistake an ordinary provider failure for a refusal', () => {
    expect(
      isContentRefusal(chatErrorFrom('{"error":{"message":"rate limited"}}', 'Rate limited'))
    ).toBe(false);
    expect(isContentRefusal(new Error('HTTP 429: rate limited'))).toBe(false);
    expect(isContentRefusal(new Error('Failed to parse JSON from completion'))).toBe(false);
    expect(isContentRefusal(undefined)).toBe(false);
  });

  // The token is reachable ONLY through the whole-object stringify, and the object is cyclic —
  // so this fails both if the backstop is dropped and if the cycle handling is, rather than
  // being answered by `.message`/`.body` the way a flatter fixture would be.
  it('finds a refusal nested somewhere new, on an object that cannot be naively stringified', () => {
    const nested: Record<string, unknown> = {
      detail: { upstream: { raw: 'data_inspection_failed' } },
    };
    nested.self = nested;

    expect(isContentRefusal(nested)).toBe(true);
  });
});
