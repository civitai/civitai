import { z } from 'zod';

export const comicProjectMetaSchema = z.object({
  allowDownload: z.boolean().optional(),
  // 'rtl' = right-to-left manga layout. Absent / 'ltr' = default behavior.
  readingDirection: z.enum(['ltr', 'rtl']).optional(),
});
export type ComicProjectMeta = z.infer<typeof comicProjectMetaSchema>;

export function parseComicProjectMeta(raw: unknown): ComicProjectMeta | null {
  const result = comicProjectMetaSchema.safeParse(raw);
  return result.success ? result.data : null;
}
