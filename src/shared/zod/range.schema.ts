import * as z from 'zod';
import type { Range } from '~/shared/constants/basemodel.constants';

/** The one zod form of `Range`, shared by the graph and the server so neither drifts. */
export const rangeSchema: z.ZodType<Range> = z.object({
  min: z.number(),
  max: z.number(),
  default: z.number(),
});
