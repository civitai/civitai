import * as z from 'zod/v4';
import { ToolSort } from '~/server/common/enums';
import { infiniteQuerySchema } from '~/server/schema/base.schema';
import { ToolType } from '~/shared/utils/prisma/enums';

export type ToolMetadata = z.infer<typeof toolMetadata>;
export const toolMetadata = z.object({ header: z.string().optional() });

export type GetAllToolsSchema = z.infer<typeof getAllToolsSchema>;
export const getAllToolsSchema = infiniteQuerySchema.extend({
  limit: z.number().min(1).max(100).optional(),
  query: z.string().optional(),
  sort: z.nativeEnum(ToolSort).optional(),
  type: z.nativeEnum(ToolType).optional(),
  company: z.string().optional(),
  include: z.enum(['unlisted']).array().optional(),
});
