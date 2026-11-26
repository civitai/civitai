import { describe, expect, it } from 'vitest';
import { AI_MODELS } from '~/server/services/ai/openrouter';

// INVARIANT GUARD, not a liveness check: CI has no network, so this cannot ask OpenRouter
// whether an id still exists. It pins every id in AI_MODELS to an explicit list that a human
// checked against https://openrouter.ai/api/v1/models (public, no key needed).
//
// Why it exists: OpenRouter retires old ids outright rather than aliasing them, and a retired id
// 404s on every call. `anthropic/claude-3-5-haiku`, `anthropic/claude-sonnet-4` and
// `stepfun/step-3.5-flash` went that way while AI_MODELS still named them, and the only signal
// was a feature failing.
//
// Adding or changing an AI_MODELS id fails here until the new id is added below, which forces
// the check against the live list at the moment someone picks a model.
const LIVE_IDS = [
  // Checked present in the live list on 2026-11-25.
  'anthropic/claude-haiku-5.5',
  'anthropic/claude-sonnet-5.5',
  'moonshotai/kimi-k2.5',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-5-nano',
  'openai/gpt-5.6-luna',
  'openai/gpt-6-luna',
  'qwen/qwen3.7-flash',
  'stepfun/step-3.7-flash',
  'x-ai/grok-4.3',
] as const;

// Keys whose id is knowingly absent from the public list. Each needs a reason; none of them is
// "nobody checked".
const KNOWN_ABSENT: Record<string, string> = {
  // Only a key in the daily-challenge price table; a new id there would carry old prices.
  MIMO: 'xiaomi/mimo-v2.5',
  // Marked DEAD in openrouter.ts and unused.
  GROK: 'x-ai/grok-4.1-fast',
  // Numbered pin on purpose (see jev.ts); not necessarily listed publicly.
  JEV: 'typesafe/jev-1.13',
};

describe('AI_MODELS ids (invariant guard)', () => {
  const checked = Object.entries(AI_MODELS).filter(([key]) => !(key in KNOWN_ABSENT));

  it('exempts exactly the known-absent keys, with the ids they were exempted for', () => {
    const exempt = Object.fromEntries(
      Object.entries(AI_MODELS).filter(([key]) => key in KNOWN_ABSENT)
    );
    expect(exempt).toEqual(KNOWN_ABSENT);
  });

  it.each(checked)('%s (%s) is a known-live id', (_key, id) => {
    expect(LIVE_IDS).toContain(id);
  });
});
