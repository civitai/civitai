import { describe, expect, it } from 'vitest';
import { reportModalTitle } from '~/components/Modals/ReportModal';
import { ReportEntity, reportEntityLabels } from '~/shared/utils/report-helpers';

describe('the report dialog title', () => {
  it('reads "Report Service" for an offering, not the half-split enum value', () => {
    expect(reportModalTitle({ entityType: ReportEntity.ServiceOffering, selected: null })).toBe(
      'Report Service'
    );
  });

  it('names every reportable thing from its label', () => {
    for (const entityType of Object.values(ReportEntity))
      expect(reportModalTitle({ entityType, selected: null })).toBe(
        `Report ${reportEntityLabels[entityType]}`
      );
  });

  it('does not split a camelCase entity into "Bounty Entry" halves', () => {
    expect(reportModalTitle({ entityType: ReportEntity.BountyEntry, selected: null })).toBe(
      'Report Bounty entry'
    );
  });

  it("uses the chosen reason's own label once a reason is picked", () => {
    expect(
      reportModalTitle({
        entityType: ReportEntity.ServiceOffering,
        selected: { key: 'spam', label: 'Spam' },
      })
    ).toBe('Spam');
  });

  it('keeps "Report this note" for a flag on a sticker comment', () => {
    expect(
      reportModalTitle({
        entityType: ReportEntity.Image,
        selected: { key: 'sticker-placement', label: 'Report this sticker' },
        placementTarget: 'comment',
      })
    ).toBe('Report this note');
  });
});
