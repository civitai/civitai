import { describe, expect, it } from 'vitest';
import {
  COLLECTION_REJECTION_REASON_COPY,
  DETAIL_BACKED_REASONS,
  SELECTABLE_REJECTION_REASONS,
  resolveRejectionCopy,
} from '~/shared/constants/collection-rejection.constants';
import { CollectionItemRejectionReason } from '~/shared/utils/prisma/enums';

describe('collection rejection reasons', () => {
  it('resolves a canned reason to its copy', () => {
    expect(resolveRejectionCopy({ reason: CollectionItemRejectionReason.OffTopic })).toBe(
      "It doesn't fit this collection's theme."
    );
  });

  it('resolves Other to whatever detail the row carries', () => {
    expect(
      resolveRejectionCopy({
        reason: CollectionItemRejectionReason.Other,
        detail: '  Please crop out the watermark.  ',
      })
    ).toBe('Please crop out the watermark.');
  });

  it('resolves Automated to the message the AI reviewer supplied', () => {
    expect(
      resolveRejectionCopy({
        reason: CollectionItemRejectionReason.Automated,
        detail: 'This collection needs to stay PG-13.',
      })
    ).toBe('This collection needs to stay PG-13.');
  });

  it('resolves to undefined when Other carries no detail', () => {
    expect(
      resolveRejectionCopy({ reason: CollectionItemRejectionReason.Other, detail: '   ' })
    ).toBeUndefined();
  });

  it('resolves to undefined when no reason was given', () => {
    expect(resolveRejectionCopy({})).toBeUndefined();
  });

  // Reviewers cannot write free text, so the reasons that read their copy from it are exactly
  // the ones a reviewer must not be offered.
  it('offers no reason whose copy comes from free text', () => {
    for (const reason of DETAIL_BACKED_REASONS)
      expect(SELECTABLE_REJECTION_REASONS).not.toContain(reason);
    expect(SELECTABLE_REJECTION_REASONS).toContain(CollectionItemRejectionReason.OffTopic);
  });

  // Drift guard: adding an enum member without copy for it would otherwise ship a
  // rejection that renders as an empty sentence.
  it('has copy defined for every enum member', () => {
    expect(Object.keys(COLLECTION_REJECTION_REASON_COPY).sort()).toEqual(
      Object.values(CollectionItemRejectionReason).sort()
    );
  });

  // The set check above only compares keys, so a new reason added with '' copy would pass it
  // while rendering nothing. Anything a reviewer can pick has to resolve to a real sentence.
  it('resolves every selectable reason to non-empty copy', () => {
    for (const reason of SELECTABLE_REJECTION_REASONS)
      expect(resolveRejectionCopy({ reason })).toBeTruthy();
  });
});
