import * as z from 'zod';

export const userId = z.coerce.number().int().positive().describe('The account to act on.');
export const displayName = z.string().trim().max(128);
