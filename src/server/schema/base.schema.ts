import { z } from 'zod';

export const getByIdSchema = z.object({ id: z.number() });
export type GetByIdInput = z.infer<typeof getByIdSchema>;
