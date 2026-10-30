import { describe, expect, it } from 'vitest';

import { getReportItemUrl, reportEntityForSlug, reportEntityLabels, reportPath } from '../reports';
import { OWNED_REPORT_ENTITIES, reportEntity } from '../server/report-entities';

describe('service offering report type', () => {
  it('is reachable by its queue slug', () => {
    expect(reportEntityForSlug('service')).toBe('serviceOffering');
    expect(reportPath('serviceOffering')).toBe('/reports/service');
    expect(reportEntityLabels.serviceOffering).toBe('Service');
  });

  it('joins through ServiceOfferingReport and is owned by the seller', () => {
    expect(reportEntity('serviceOffering')).toMatchObject({
      reportTable: 'ServiceOfferingReport',
      fk: 'serviceOfferingId',
      table: 'ServiceOffering',
      ownerColumn: 'sellerId',
    });
    expect(OWNED_REPORT_ENTITIES.map((e) => e.type)).toContain('serviceOffering');
  });

  // An offering has no page of its own, so its link is the seller's shop, resolved in SQL
  // (pinned in reports.sql.test.ts) and used as given.
  it("links to the seller's shop", () => {
    expect(
      getReportItemUrl('https://civitai.com', 'serviceOffering', 5, '/user/badgesmith/shop')
    ).toBe('https://civitai.com/user/badgesmith/shop');
  });
});
