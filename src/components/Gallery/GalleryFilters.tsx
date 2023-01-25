import { useRouter } from 'next/router';
import z from 'zod';

const queryStringSchema = z
  .object({
    modelId: z.preprocess(Number, z.number()),
    modelVersionId: z.preprocess(Number, z.number()),
    reviewId: z.preprocess(Number, z.number()),
    userId: z.preprocess(Number, z.number()),
    active: z.preprocess((arg) => Boolean(arg !== undefined), z.boolean()),
  })
  .partial();

export const useGalleryFilters = () => {
  const router = useRouter();
  const result = queryStringSchema.safeParse(router.query);
  // TODO - get additional zustand filters (if any)
  return result.success ? { ...result.data } : {};
};
