import * as z from 'zod/v4';

export const airConfirmSchema = z.object({
  email: z.string().email(),
});
