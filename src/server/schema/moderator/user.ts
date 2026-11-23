import * as z from 'zod';

export const userId = z.coerce.number().int().positive().describe('The account to act on.');
/** The profile text fields a moderator can clear. */
export const PROFILE_CLEAR_FIELDS = [
  'location',
  'bio',
  'message',
  'showcaseSections',
  'folderRows',
] as const;
export const displayName = z.string().trim().max(128);
