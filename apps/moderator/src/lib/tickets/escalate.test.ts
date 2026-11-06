import { describe, expect, it } from 'vitest';
import { CUSTOMER_SUPPORT_GROUP_ID, escalationFields } from './escalate';
import { SENT_TO_SUPPORT_TAG } from './routing';

describe('escalationFields', () => {
  it('keeps every existing tag and adds the sent-to-support tag', () => {
    const f = escalationFields(['Free User', 'Buzz'], 2);
    expect(f.tags).toEqual(['Free User', 'Buzz', SENT_TO_SUPPORT_TAG]);
    expect(f.group_id).toBe(CUSTOMER_SUPPORT_GROUP_ID);
  });

  it('does not duplicate the tag, whatever its case', () => {
    expect(escalationFields(['Sent-To-Support', 'a'], 2).tags).toEqual(['Sent-To-Support', 'a']);
  });

  it('moves "Waiting on Mod Lead" to Open and leaves any other status alone', () => {
    expect(escalationFields([], 8).status).toBe(2);
    for (const status of [2, 3, 6, 7, 9])
      expect(escalationFields([], status)).not.toHaveProperty('status');
  });
});
