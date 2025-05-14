import { z } from 'zod';
import { infiniteQuerySchema } from '~/server/schema/base.schema';
import { ChangelogType } from '~/shared/utils/prisma/enums';

export type GetChangelogsInput = z.infer<typeof getChangelogsInput>;
export const getChangelogsInput = infiniteQuerySchema.extend({
  limit: z.number().min(1).max(500).optional().default(30),
  sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
  search: z.string().optional(),
  dateBefore: z.date().optional(),
  dateAfter: z.date().optional(),
  types: z.nativeEnum(ChangelogType).array().optional(),
  tags: z.string().array().optional(),
});

export type CreateChangelogInput = z.infer<typeof createChangelogInput>;
export const createChangelogInput = z.object({
  title: z.string().min(1),
  titleColor: z.string().optional(),
  content: z.string().min(1),
  link: z.string().url().optional().or(z.literal('')),
  //   link: z.string().optional().refine(value => !value || /^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})(\/[\w.-]*)*\/?$/.test(value), {
  //     message: "Please provide a valid URL",
  // }),
  cta: z.string().url().optional().or(z.literal('')),
  effectiveAt: z.date(),
  type: z.nativeEnum(ChangelogType),
  tags: z.string().array().optional(),
  disabled: z.boolean().optional().default(false),
  sticky: z.boolean().optional().default(false),
});

export type UpdateChangelogInput = z.infer<typeof updateChangelogInput>;
export const updateChangelogInput = createChangelogInput.partial().extend({
  id: z.number(),
});

export type DeleteChangelogInput = z.infer<typeof deleteChangelogInput>;
export const deleteChangelogInput = z.object({
  id: z.number(),
});
