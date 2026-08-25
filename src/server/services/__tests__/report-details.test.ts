import { describe, expect, it } from 'vitest';
import { withAdditionalReport } from '~/server/services/report-details';

const at = new Date('2026-08-24T12:00:00.000Z');

type Merged = { additionalReports: { userId: number; createdAt: string; details: unknown }[] };

describe('withAdditionalReport', () => {
  it("keeps the second reporter's comment instead of dropping it", () => {
    const merged = withAdditionalReport(
      { reportType: 'image', comment: 'first reporter said this' },
      { userId: 22, details: { reportType: 'image', comment: 'second reporter said this' }, at }
    ) as unknown as Merged;

    expect(merged.additionalReports).toHaveLength(1);
    expect(merged.additionalReports[0]).toEqual({
      userId: 22,
      createdAt: at.toISOString(),
      details: { comment: 'second reporter said this' },
    });
  });

  it("leaves the first reporter's details untouched", () => {
    const merged = withAdditionalReport(
      { reportType: 'image', comment: 'first reporter said this' },
      { userId: 22, details: { comment: 'second' }, at }
    ) as unknown as Merged & { comment: string; reportType: string };

    expect(merged.comment).toBe('first reporter said this');
    expect(merged.reportType).toBe('image');
  });

  it('accumulates a third reporter rather than replacing the second', () => {
    const first = withAdditionalReport(
      { comment: 'first' },
      { userId: 2, details: { comment: 'second' }, at }
    );
    const second = withAdditionalReport(first as never, {
      userId: 3,
      details: { comment: 'third' },
      at,
    }) as unknown as Merged;

    expect(second.additionalReports.map((r) => r.userId)).toEqual([2, 3]);
  });

  // `createReport` stamps `reportType` onto every report, so "has details" is never literally empty.
  it('returns undefined when the duplicate carries nothing but reportType', () => {
    expect(
      withAdditionalReport(
        { comment: 'first' },
        { userId: 22, details: { reportType: 'image' }, at }
      )
    ).toBeUndefined();
    expect(
      withAdditionalReport({ comment: 'first' }, { userId: 22, details: {}, at })
    ).toBeUndefined();
    expect(withAdditionalReport({ comment: 'first' }, { userId: 22, at })).toBeUndefined();
  });

  it('survives a first report whose details are null or a non-object', () => {
    for (const existing of [null, 'nonsense', 42, ['a']] as const) {
      const merged = withAdditionalReport(existing as never, {
        userId: 7,
        details: { comment: 'kept anyway' },
        at,
      }) as unknown as Merged;
      expect(merged.additionalReports).toHaveLength(1);
    }
  });
});
