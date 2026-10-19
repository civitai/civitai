import { z } from 'zod';

/** One playbook version as a form posts it. Shared by the create and edit actions. */
export const playbookDraftSchema = z.object({
  title: z.string().trim().min(3, 'A title is at least 3 characters.').max(120),
  summary: z.string().trim().min(10, 'Say in a sentence when to use it.').max(300),
  body: z.string().trim().min(20, 'Write the steps.').max(8000),
  note: z
    .string()
    .trim()
    .max(500)
    .transform((v) => v || null)
    .optional()
    .default(null),
});

export const playbookSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase letters, digits and single hyphens.')
  .max(60);

export const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? 'Invalid playbook.';
