import * as z from 'zod';

/**
 * Username length bounds, as constants so a consumer can DERIVE from them rather than
 * restate the number. `usernameInputSchema` in `~/server/schema/user.schema` applies them;
 * that module pulls the feature-flag service, so anything needing only the bound (a layout
 * fixture sizing a cell to its worst case) imports from here instead.
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 25;

export const usernameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_]*$/, 'The "username" field can only contain letters, numbers, and _.')
  .trim();
