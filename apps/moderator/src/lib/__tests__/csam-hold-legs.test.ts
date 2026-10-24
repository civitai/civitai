import { describe, expect, it } from 'vitest';
import { holdLegLabels } from '../csam-hold-legs';

// The label is what tells a moderator why a user is held. A swapped pair compiles, so pin each one.
describe('hold leg labels', () => {
  it('names every leg, in the order given', () => {
    expect(
      holdLegLabels([
        'csamReport',
        'csamReportSecondary',
        'ban',
        'reportedImage',
        'evidenceHold',
        'evidenceHoldUnknown',
      ])
    ).toBe(
      'Named on a CSAM report, Secondary user on a CSAM report, Ban hold, ' +
        'Image listed on a CSAM report, Evidence hold, Evidence-hold status unknown'
    );
  });
});
