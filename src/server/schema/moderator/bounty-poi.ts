import * as z from 'zod';

export const bountyId = z.coerce.number().int().positive().describe('The bounty to act on.');

export const bountyPoiRateLimit = { max: 60, windowSeconds: 60 } as const;
