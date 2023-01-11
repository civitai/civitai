import { z } from 'zod';

export const getByIdSchema = z.object({ id: z.number() });
export type GetByIdInput = z.infer<typeof getByIdSchema>;

export const getAllQuerySchema = z.object({
  limit: z.preprocess((val) => Number(val), z.number().min(0).max(200).default(20)).optional(),
  page: z.preprocess((val) => Number(val), z.number().min(1)).optional(),
  query: z.string().optional(),
});
export type GetAllSchema = z.infer<typeof getAllQuerySchema>;

// type BaseInterface = {
//   id?: number;
// } & Record<string, unknown>;
// type OmitId<T extends BaseInterface> = Omit<T, 'id'>;

// export const isEntity = <T extends BaseInterface>(
//   entity: T
// ): entity is OmitId<T> & { id: number } => !!entity.id;
