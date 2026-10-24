// Fixture for no-coerce-boolean-in-api.test.ts: the shape the guard must catch. Kept out of
// src/pages/api so it is a control for the matcher, not a violation of the rule.
import * as z from 'zod';

export const schema = z.object({
  dryRun: z.coerce.boolean().optional(),
});
