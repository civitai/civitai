import { describe, expect, it } from 'vitest';
import { PUSH_PROMPT_ROWS } from '~/components/Notifications/pushPromptRows';
import { DEFAULT_PUSH_TYPES } from '~/server/notifications/push.constants';

// The opt-in prompt tells a new subscriber what we will push. That list has to be exactly what
// granting permission turns on (DEFAULT_PUSH_TYPES), or the prompt promises the wrong thing.
describe('PUSH_PROMPT_ROWS', () => {
  const listed: string[] = PUSH_PROMPT_ROWS.flatMap((row) => [...row.types]);

  it('lists only types that are push-on by default', () => {
    expect(listed.filter((t) => !DEFAULT_PUSH_TYPES.includes(t))).toEqual([]);
  });

  it('leaves no default push type out', () => {
    expect(DEFAULT_PUSH_TYPES.filter((t) => !listed.includes(t))).toEqual([]);
  });
});
