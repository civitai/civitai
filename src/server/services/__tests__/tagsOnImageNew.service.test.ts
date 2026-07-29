import { vi, describe, it, expect, beforeEach } from 'vitest';
import { applyTagRules } from '../tagsOnImageNew.service';
import * as systemCache from '../system-cache';

vi.mock('~/server/db/client', () => ({
  dbWrite: { $executeRawUnsafe: vi.fn() },
}));
vi.mock('~/server/db/pgDb', () => ({
  pgDbWrite: { query: vi.fn() },
}));
vi.mock('~/server/redis/caches', () => ({
  tagIdsForImagesCache: { bust: vi.fn() },
  thumbnailCache: { refresh: vi.fn() },
  imageTagsCache: { bust: vi.fn() },
}));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: vi.fn(),
}));

vi.mock('../system-cache', () => ({
  getTagRules: vi.fn(),
  getModeratedTags: vi.fn(),
}));

describe('tagsOnImageNew.service', () => {
  describe('applyTagRules', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should correctly deduplicate Append rules recursively and prevent exponential growth', async () => {
      // Mock tag rules to simulate a cascading append scenario:
      // tag 1 -> appends tag 2
      // tag 2 -> appends tag 3
      // tag 3 -> appends tag 4
      vi.mocked(systemCache.getTagRules).mockResolvedValue([
        { toId: 1, fromId: 2, type: 'Append', fromTag: 'two', toTag: 'one', createdAt: new Date() },
        { toId: 2, fromId: 3, type: 'Append', fromTag: 'three', toTag: 'two', createdAt: new Date() },
        { toId: 3, fromId: 4, type: 'Append', fromTag: 'four', toTag: 'three', createdAt: new Date() },
      ]);

      const initialArgs = [
        { imageId: 10, tagId: 1, confidence: 100, source: 'User' },
      ] as any[];

      const result = await applyTagRules(initialArgs);

      // The rules should process sequentially:
      // 1. Appends 2 => [1, 2]
      // 2. Appends 3 => [1, 2, 3]
      // 3. Appends 4 => [1, 2, 3, 4]
      expect(result).toHaveLength(4);
      const tagIds = result.map((r) => r.tagId).sort();
      expect(tagIds).toEqual([1, 2, 3, 4]);
      
      const tag4 = result.find(r => r.tagId === 4);
      expect(tag4?.confidence).toBe(70);
      expect(tag4?.source).toBe('Computed');
    });

    it('should correctly handle Replace rules', async () => {
      vi.mocked(systemCache.getTagRules).mockResolvedValue([
        { toId: 5, fromId: 6, type: 'Replace', fromTag: 'six', toTag: 'five', createdAt: new Date() },
      ]);

      const initialArgs = [
        { imageId: 20, tagId: 5, confidence: 90, source: 'WD14' },
      ] as any[];

      const result = await applyTagRules(initialArgs);

      expect(result).toHaveLength(1);
      expect(result[0].tagId).toBe(6);
      expect(result[0].confidence).toBe(90); // Replace preserves original confidence
      expect(result[0].source).toBe('WD14'); // Replace preserves original source
    });

    it('should not duplicate tags when multiple incoming tags map to the same Append rule', async () => {
      // Multiple starting tags matching the same rule
      vi.mocked(systemCache.getTagRules).mockResolvedValue([
        { toId: 7, fromId: 9, type: 'Append', fromTag: 'nine', toTag: 'seven', createdAt: new Date() },
        { toId: 8, fromId: 9, type: 'Append', fromTag: 'nine', toTag: 'eight', createdAt: new Date() },
      ]);

      const initialArgs = [
        { imageId: 30, tagId: 7, confidence: 100, source: 'User' },
        { imageId: 30, tagId: 8, confidence: 100, source: 'User' },
      ] as any[];

      const result = await applyTagRules(initialArgs);

      // Result should be 7, 8, and 9 (only one 9, not two)
      expect(result).toHaveLength(3);
      const tagIds = result.map((r) => r.tagId).sort();
      expect(tagIds).toEqual([7, 8, 9]);
    });

    it('should not clobber a pre-existing tag when an Append rule targets it', async () => {
      // Rule appends tag 11 whenever tag 12 is present, but tag 11 already
      // exists as a genuine high-confidence User tag. First-wins must preserve it
      // rather than downgrading it to { confidence: 70, source: 'Computed' }.
      vi.mocked(systemCache.getTagRules).mockResolvedValue([
        { toId: 12, fromId: 11, type: 'Append', fromTag: 'eleven', toTag: 'twelve', createdAt: new Date() },
      ]);

      const initialArgs = [
        { imageId: 40, tagId: 11, confidence: 100, source: 'User' },
        { imageId: 40, tagId: 12, confidence: 95, source: 'WD14' },
      ] as any[];

      const result = await applyTagRules(initialArgs);

      expect(result).toHaveLength(2);
      const tag11 = result.find((r) => r.tagId === 11);
      expect(tag11?.confidence).toBe(100);
      expect(tag11?.source).toBe('User');
    });
  });
});
