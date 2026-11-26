import { describe, expect, it } from 'vitest';
import { AI_MODELS } from '~/server/services/ai/openrouter';

// INVARIANT GUARD, not a liveness check: CI has no network, so this cannot ask OpenRouter
// whether an id still exists. It pins the Anthropic ids in AI_MODELS to an explicit list that a
// human checked against https://openrouter.ai/api/v1/models (public, no key needed).
//
// Why it exists: OpenRouter retires old Anthropic ids outright rather than aliasing them, and a
// retired id 404s on every call. `anthropic/claude-3-5-haiku` and `anthropic/claude-sonnet-4`
// went that way while AI_MODELS still named them, and the only signal was a feature failing.
//
// Adding an `anthropic/` entry to AI_MODELS fails here until its id is added below, which forces
// the check against the live list at the moment someone picks a model.
const LIVE_ANTHROPIC_IDS = [
  // Checked present in the live list on 2026-11-25.
  'anthropic/claude-haiku-5.5',
  'anthropic/claude-sonnet-5.5',
] as const;

// Retired by OpenRouter: these 404. Never route to them again.
const RETIRED_ANTHROPIC_IDS = ['anthropic/claude-3-5-haiku', 'anthropic/claude-sonnet-4'] as const;

const anthropicEntries = Object.entries(AI_MODELS).filter(([, id]) => id.startsWith('anthropic/'));

describe('AI_MODELS Anthropic ids (invariant guard)', () => {
  it('has Anthropic entries to check, so the guard cannot pass on an empty set', () => {
    expect(anthropicEntries.map(([key]) => key).sort()).toEqual([
      'CLAUDE_HAIKU',
      'CLAUDE_SONNET',
      'VISION_FALLBACK',
    ]);
  });

  it.each(anthropicEntries)('%s (%s) is a known-live id', (_key, id) => {
    expect(LIVE_ANTHROPIC_IDS).toContain(id);
  });

  it.each(anthropicEntries)('%s (%s) is not a retired id', (_key, id) => {
    expect(RETIRED_ANTHROPIC_IDS).not.toContain(id);
  });

  it('pins each Anthropic alias to its exact id', () => {
    expect(AI_MODELS.CLAUDE_HAIKU).toBe('anthropic/claude-haiku-5.5');
    expect(AI_MODELS.CLAUDE_SONNET).toBe('anthropic/claude-sonnet-5.5');
    expect(AI_MODELS.VISION_FALLBACK).toBe('anthropic/claude-sonnet-5.5');
  });
});
