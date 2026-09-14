import { describe, expect, it } from 'vitest';
import { ReportEntity, reportEntityLabels } from '~/shared/utils/report-helpers';
import { getDisplayName } from '~/utils/string-helpers';

/**
 * The report toast reads `${reportEntityLabels[type]} reported`, so these strings are shown to
 * the person who filed the report.
 */
describe('reportEntityLabels', () => {
  it('labels every reportable entity', () => {
    const missing = Object.values(ReportEntity).filter((e) => !reportEntityLabels[e]?.trim());
    expect(missing).toEqual([]);
  });

  it('reads as a sentence in the toast', () => {
    expect(`${reportEntityLabels[ReportEntity.Announcement]} reported`).toBe(
      'Announcement reported'
    );
    expect(`${reportEntityLabels[ReportEntity.Model3D]} reported`).toBe('3D model reported');
    expect(`${reportEntityLabels[ReportEntity.User]} reported`).toBe('User reported');
  });

  it('starts every label with a capital, which is what the toast needs', () => {
    const uncapitalised = Object.values(ReportEntity).filter(
      (e) => reportEntityLabels[e][0] !== reportEntityLabels[e][0].toUpperCase()
    );
    expect(uncapitalised).toEqual([]);
  });

  /**
   * 🔴 The reason this map is hand-written. `getDisplayName` returns the enum value with its
   * authored capitalisation, so a "simplification" back to it ships "announcement reported" and
   * "reported User reported". Its `nameOverrides` covers `commentV2` and `model3d`, which is why
   * the breakage is partial and easy to miss when spot-checking one entity.
   */
  it('differs from getDisplayName on the entities it would mangle', () => {
    expect(getDisplayName(ReportEntity.Announcement)).toBe('announcement');
    expect(getDisplayName(ReportEntity.User)).toBe('reported User');
    expect(getDisplayName(ReportEntity.BountyEntry)).toBe('bounty Entry');

    for (const entity of [ReportEntity.Announcement, ReportEntity.User, ReportEntity.BountyEntry]) {
      expect(reportEntityLabels[entity]).not.toBe(getDisplayName(entity));
    }
  });
});
