import { describe, expect, it } from 'vitest';
import { constants } from '~/server/common/constants';
import {
  submitBountyEntryInputSchema,
  upsertBountyEntryInputSchema,
} from '~/server/schema/bounty-entry.schema';

const entry = (imageCount: number) => ({
  bountyId: 1,
  files: [{ url: 'f', name: 'f.zip', sizeKB: 1, metadata: {} }],
  images: Array.from({ length: imageCount }, (_, i) => ({ url: `img-${i}`, type: 'image' })),
});
const imageIssues = (imageCount: number) => {
  const result = upsertBountyEntryInputSchema.safeParse(entry(imageCount));
  return result.success ? [] : result.error.issues.filter((i) => i.path.join('.') === 'images');
};

describe('bounty entry image limit', () => {
  const max = constants.bounties.maxEntryImagesForEdit;

  it('accepts an entry at the limit', () => {
    expect(imageIssues(max)).toEqual([]);
  });

  it('refuses an entry over the limit', () => {
    expect(imageIssues(max + 1).map((i) => i.code)).toEqual(['too_big']);
  });

  const submitImageIssues = (imageCount: number) => {
    const result = submitBountyEntryInputSchema.safeParse({
      bountyId: 1,
      files: [{ url: 'https://example.com/f.zip', name: 'f.zip', sizeKB: 1 }],
      imageUuids: Array.from(
        { length: imageCount },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      ),
    });
    return result.success
      ? []
      : result.error.issues.filter((i) => i.path.join('.') === 'imageUuids');
  };

  it('accepts a submit at the limit', () => {
    expect(submitImageIssues(max)).toEqual([]);
  });

  it('refuses a submit over the limit', () => {
    expect(submitImageIssues(max + 1).map((i) => i.code)).toEqual(['too_big']);
  });
});
