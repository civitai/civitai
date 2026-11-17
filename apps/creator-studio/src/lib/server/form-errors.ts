import type { z } from 'zod';

export const firstError = (e: z.ZodError) => e.issues[0]?.message ?? 'Invalid input.';
