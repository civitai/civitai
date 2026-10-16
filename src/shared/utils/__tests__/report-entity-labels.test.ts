import { describe, expect, it } from 'vitest';
import { ReportEntity, reportEntityLabels } from '~/shared/utils/report-helpers';

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
});
