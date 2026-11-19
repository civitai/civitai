import { describe, expect, it } from 'vitest';
import { CSAM_REPORT_CHOICES, reportChoicesFor } from '$lib/csam-holds/report-choice';

describe('reportChoicesFor', () => {
  it('leaves "none" out of the report decision only', () => {
    expect(reportChoicesFor('remove_ban_report')).not.toContain('none');
    for (const decision of ['remove', 'remove_strike', 'remove_ban'])
      expect(reportChoicesFor(decision)).toEqual(CSAM_REPORT_CHOICES);
  });
});
