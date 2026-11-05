import type { ImageSearchFilter, imageSearchInput } from '@civitai/search';
import type * as z from 'zod';
import type { QueryEmbedder } from './embedder';
import type { QdrantFilter, VectorIndex } from './qdrant';

export function buildImageFilter(f: ImageSearchFilter): QdrantFilter {
  const must: unknown[] = [{ key: 'nsfwLevel', match: { any: f.nsfwLevels } }];
  // Every listed tag, not any of them: each added tag narrows the results.
  for (const tagId of f.tagIds ?? []) must.push({ key: 'tagIds', match: { value: tagId } });
  if (f.baseModels?.length) must.push({ key: 'baseModels', match: { any: f.baseModels } });
  if (f.types?.length) must.push({ key: 'type', match: { any: f.types } });
  if (f.userIds?.length) must.push({ key: 'userId', match: { any: f.userIds } });
  if (f.postedAfter || f.postedBefore)
    must.push({ key: 'sortAt', range: { gte: f.postedAfter, lte: f.postedBefore } });

  const must_not: unknown[] = [];
  if (f.excludedTagIds?.length) must_not.push({ key: 'tagIds', match: { any: f.excludedTagIds } });
  if (f.excludedUserIds?.length)
    must_not.push({ key: 'userId', match: { any: f.excludedUserIds } });
  if (f.excludedImageIds?.length) must_not.push({ has_id: f.excludedImageIds });
  if (f.restrictedBaseModels)
    must_not.push({
      must: [
        { key: 'nsfwLevel', match: { any: f.restrictedBaseModels.nsfwLevels } },
        { key: 'baseModels', match: { any: f.restrictedBaseModels.baseModels } },
      ],
    });

  return { must, must_not };
}

export async function searchImages(
  input: z.output<typeof imageSearchInput>,
  { index, embed }: { index: VectorIndex; embed: QueryEmbedder }
) {
  const query =
    'similarTo' in input.query
      ? input.query.similarTo
      : await embed(input.query.text, await index.stamp());
  const filter = buildImageFilter(input.filter);
  // The source image of "more like this" is always its own best match.
  if ('similarTo' in input.query) filter.must_not.push({ has_id: [input.query.similarTo] });

  const ids = await index.query({ query, filter, offset: input.offset, limit: input.limit });
  return { ids };
}
