import { describe, expect, it } from 'vitest';
import { seedOutcome, type HashDetail } from '../hash-detail';

const seed = (over: Partial<NonNullable<HashDetail['detail']>>) =>
  ({
    minorModelStatus: 'Published',
    minorModelMode: null,
    minorModelUnpublishedAt: null,
    minorModelUnpublishedReason: null,
    minorModelDeletedAt: null,
    ...over,
  } as NonNullable<HashDetail['detail']>);

describe('seedOutcome', () => {
  it('says a deleted seed is deleted, whatever it was before', () => {
    expect(
      seedOutcome(
        seed({ minorModelStatus: 'UnpublishedViolation', minorModelDeletedAt: '2026-01-02' })
      )
    ).toMatchObject({ tone: 'down', text: 'deleted', at: '2026-01-02' });
  });

  it('says a taken-down seed is down although its status still reads Published', () => {
    expect(seedOutcome(seed({ minorModelMode: 'TakenDown' }))).toMatchObject({
      tone: 'down',
      text: 'taken down',
    });
  });

  it('carries the date and reason of a violation unpublish', () => {
    expect(
      seedOutcome(
        seed({
          minorModelStatus: 'UnpublishedViolation',
          minorModelUnpublishedAt: '2026-03-04',
          minorModelUnpublishedReason: 'minor',
        })
      )
    ).toEqual({
      tone: 'down',
      text: 'unpublished as a violation',
      at: '2026-03-04',
      reason: 'minor',
    });
  });

  it('does not call an owner unpublish a violation', () => {
    expect(seedOutcome(seed({ minorModelStatus: 'Unpublished' })).text).toBe(
      'unpublished by its owner'
    );
  });

  it('says a published seed is still live', () => {
    expect(seedOutcome(seed({})).tone).toBe('live');
  });
});

describe('seedOutcome, statuses the site sets itself', () => {
  it('says a drafted seed is off the site, not still published', () => {
    expect(seedOutcome(seed({ minorModelStatus: 'Draft' }))).toMatchObject({
      tone: 'down',
      text: 'moved back to draft',
    });
  });

  it("does not credit the site's own unpublish to the owner", () => {
    expect(
      seedOutcome(
        seed({ minorModelStatus: 'Unpublished', minorModelUnpublishedReason: 'no-versions' })
      ).text
    ).toBe('unpublished by the site for missing content');
  });

  it('names a status it has no wording for rather than calling it published', () => {
    expect(seedOutcome(seed({ minorModelStatus: 'Scheduled' })).text).toBe(
      'left in status Scheduled'
    );
  });
});
