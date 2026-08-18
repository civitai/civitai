import * as z from 'zod';

export const modelId = z.coerce.number().int().positive().describe('The model to act on.');

// A per-model verdict a moderator clicks, so the ceiling bounds a stuck client rather than pacing
// real work.
export const minorFlagRateLimit = { max: 60, windowSeconds: 60 } as const;
