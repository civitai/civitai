import { describe, expect, it } from 'vitest';
import { generationStatusRefusal } from '~/server/services/generation/generation-kill-switch';
import { generationStatusDefaultMessage } from '~/server/schema/generation.schema';

// The one decision every generation entry point applies to the global kill switch.

const MESSAGE = 'Generation is paused while we fix an incident.';

describe('generationStatusRefusal', () => {
  it.each([
    ['disabled', 'free'],
    ['disabled', 'gold'],
    ['memberOnly', 'free'],
  ] as const)('refuses a non-moderator when mode is %s and tier is %s', (mode, tier) => {
    expect(generationStatusRefusal({ mode, message: MESSAGE }, { tier })).toBe(MESSAGE);
  });

  it('falls back to the default message when the operator left none', () => {
    expect(generationStatusRefusal({ mode: 'disabled', message: null }, { tier: 'free' })).toBe(
      generationStatusDefaultMessage
    );
  });

  it('treats a caller with no tier as free', () => {
    expect(generationStatusRefusal({ mode: 'memberOnly', message: MESSAGE }, {})).toBe(MESSAGE);
  });

  it.each([
    ['enabled', 'free', false],
    ['memberOnly', 'bronze', false],
    ['disabled', 'free', true],
    ['memberOnly', 'free', true],
  ] as const)('allows mode %s, tier %s, moderator %s', (mode, tier, isModerator) => {
    expect(generationStatusRefusal({ mode, message: MESSAGE }, { tier, isModerator })).toBeNull();
  });
});
