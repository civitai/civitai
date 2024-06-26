import { z } from 'zod';

export type ToolMetadata = z.infer<typeof toolMetadata>;
export const toolMetadata = z.object({ header: z.string().optional() });
