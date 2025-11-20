import * as z from 'zod';

export const tagVotableEntitySchema = z.enum(['model', 'image']);
export type TagVotableEntityType = z.infer<typeof tagVotableEntitySchema>;
