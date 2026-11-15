import { describe, expect, it } from 'vitest';
import {
  CSAM_REPORT_CHOICES,
  reportChoiceCopy,
  reportChoicesFor,
} from '$lib/csam-holds/report-choice';
import { CSAM_HOLD_ENTITY_TYPES } from '../../../routes/csam/text-holds/hold-entity';

const RETENTION = /1 year from today, then it is deleted/;

describe('reportChoiceCopy', () => {
  it.each(CSAM_HOLD_ENTITY_TYPES)(
    'promises retention for "None" only on a PostText hold: %s',
    (type) => {
      const none = reportChoiceCopy('none', type);
      expect(none.title).toBe('None of these');
      expect(none.body.startsWith('Confirm with no report.')).toBe(true);
      expect(RETENTION.test(none.body)).toBe(type === 'PostText');
    }
  );

  it('never adds the retention sentence to a reportable choice', () => {
    for (const type of CSAM_HOLD_ENTITY_TYPES)
      for (const choice of CSAM_REPORT_CHOICES.filter((c) => c !== 'none'))
        expect(reportChoiceCopy(choice, type).body).not.toMatch(RETENTION);
  });
});

describe('reportChoicesFor', () => {
  it('leaves "none" out of the report decision only', () => {
    expect(reportChoicesFor('remove_ban_report')).not.toContain('none');
    for (const decision of ['remove', 'remove_strike', 'remove_ban'])
      expect(reportChoicesFor(decision)).toEqual(CSAM_REPORT_CHOICES);
  });
});
