import { describe, expect, it } from 'vitest';
import { getReportSeries, getStackPartner } from '../report-series';

const report = [
  {
    date: '2026-10-01T00:00:00',
    accounts: [
      { accountType: 'yellow', gained: 10, spent: 4 },
      { accountType: 'green', gained: 7, spent: 1 },
    ],
  },
  { date: '2026-10-02T00:00:00', accounts: [{ accountType: 'yellow', gained: 3, spent: 0 }] },
];

describe('getReportSeries', () => {
  it('reads the requested account and field per bucket', () => {
    expect(getReportSeries(report, 'green', 'gained', 'MMM-DD')).toEqual({
      'Oct-01': 7,
      'Oct-02': 0,
    });
  });
});

describe('getReportSeries onlyLabels', () => {
  it('drops buckets the chart has no tick for', () => {
    expect(getReportSeries(report, 'yellow', 'gained', 'MMM-DD', ['Oct-02'])).toEqual({
      'Oct-02': 3,
    });
  });
});

describe('getStackPartner', () => {
  it('pairs yellow with green and leaves other currencies alone', () => {
    expect(getStackPartner('yellow')).toBe('green');
    expect(getStackPartner('green')).toBe('yellow');
    expect(getStackPartner('blue')).toBeUndefined();
  });
});
