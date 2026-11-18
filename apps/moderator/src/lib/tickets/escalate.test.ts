import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_SUPPORT_GROUP_ID,
  escalationFields,
  modLeadFields,
  privacyFields,
} from './escalate';
import { MOD_LEAD_REVIEW_TAG, PRIVACY_REQUEST_TAG, SENT_TO_SUPPORT_TAG } from './routing';

describe('escalationFields', () => {
  it('keeps every existing tag and adds the sent-to-support tag', () => {
    const f = escalationFields(['Free User', 'Buzz'], 2);
    expect(f.tags).toEqual(['Free User', 'Buzz', SENT_TO_SUPPORT_TAG]);
    expect(f.group_id).toBe(CUSTOMER_SUPPORT_GROUP_ID);
  });

  it('does not duplicate the tag, whatever its case', () => {
    expect(escalationFields(['Sent-To-Support', 'a'], 2).tags).toEqual(['Sent-To-Support', 'a']);
  });

  it('drops the mod-lead tag, whatever its case, and keeps the rest in order', () => {
    expect(escalationFields(['a', 'Mod-Lead-Review', 'b'], 8).tags).toEqual([
      'a',
      'b',
      SENT_TO_SUPPORT_TAG,
    ]);
    expect(escalationFields(['a', MOD_LEAD_REVIEW_TAG], 2).tags).toEqual([
      'a',
      SENT_TO_SUPPORT_TAG,
    ]);
  });

  it('moves "Waiting on Mod Lead" to Open and leaves any other status alone', () => {
    expect(escalationFields([], 8).status).toBe(2);
    for (const status of [2, 3, 6, 7, 9])
      expect(escalationFields([], status)).not.toHaveProperty('status');
  });
});

describe('privacyFields', () => {
  it('keeps every tag, adds the privacy tag once, and sets Waiting on Dev with no group or priority', () => {
    expect(privacyFields(['Free User'])).toEqual({
      tags: ['Free User', PRIVACY_REQUEST_TAG],
      status: 7,
    });
    expect(privacyFields(['PRIVACY-REQUEST']).tags).toEqual(['PRIVACY-REQUEST']);
  });
});

describe('modLeadFields', () => {
  it('keeps every tag, adds the mod-lead tag once, and sets Waiting on Mod Lead', () => {
    expect(modLeadFields(['a'])).toEqual({ tags: ['a', MOD_LEAD_REVIEW_TAG], status: 8 });
    expect(modLeadFields([MOD_LEAD_REVIEW_TAG]).tags).toEqual([MOD_LEAD_REVIEW_TAG]);
  });
});
