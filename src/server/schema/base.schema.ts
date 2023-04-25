import { z } from 'zod';
import { parseNumericString } from '~/utils/query-string-helpers';

export const getByIdSchema = z.object({ id: z.number() });
export type GetByIdInput = z.infer<typeof getByIdSchema>;

export type PaginationInput = z.infer<typeof paginationSchema>;
export const paginationSchema = z.object({
  limit: z.preprocess(parseNumericString, z.number().min(1).max(200).default(20)),
  page: z.preprocess(parseNumericString, z.number().min(0).default(1)),
});

export const getAllQuerySchema = paginationSchema.extend({
  query: z.string().optional(),
});
export type GetAllSchema = z.infer<typeof getAllQuerySchema>;

export const periodModeSchema = z.enum(['stats', 'published']).default('published');
export type PeriodMode = z.infer<typeof periodModeSchema>;

// type BaseInterface = {
//   id?: number;
// } & Record<string, unknown>;
// type OmitId<T extends BaseInterface> = Omit<T, 'id'>;

// export const isEntity = <T extends BaseInterface>(
//   entity: T
// ): entity is OmitId<T> & { id: number } => !!entity.id;
