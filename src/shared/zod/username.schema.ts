import * as z from 'zod';

export const usernameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]*$/, 'The "username" field can only contain letters, numbers, and _.')
  .trim();
