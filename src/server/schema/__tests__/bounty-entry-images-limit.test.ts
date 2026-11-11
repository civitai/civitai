import { describe, expect, it } from 'vitest';
import { constants } from '~/server/common/constants';
import { upsertBountyEntryInputSchema } from '~/server/schema/bounty-entry.schema';

const entry = (imageCount: number) => ({
  bountyId: 1,
  files: [{ url: 'f', name: 'f.zip', sizeKB: 1, metadata: {} }],
  images: Array.from({ length: imageCount }, (_, i) => ({ url: `img-${i}`, type: 'image' })),
});
const imageIssues = (imageCount: number) => {
  const result = upsertBountyEntryInputSchema.safeParse(entry(imageCount));
  return result.success ? [] : result.error.issues.filter((i) => i.path.join('.') === 'images');
};

// An edit's read returns at most this many images and the save unlinks the rest, so a larger entry
// must be refused at write time, not truncated on its next edit.
describe('bounty entry image limit', () => {
  const max = constants.bounties.maxEntryImagesForEdit;

  it('accepts an entry at the limit', () => {
    expect(imageIssues(max)).toEqual([]);
  });

  it('refuses an entry over the limit', () => {
    expect(imageIssues(max + 1).map((i) => i.code)).toEqual(['too_big']);
  });
});
