import { z } from 'zod';

export const airConfirmSchema = z.object({
  email: z.string().email(),
});
