import { dbWrite } from '~/server/db/client';
import { hasNsfwWords } from '~/utils/metadata/audit';

export async function upsertImageFlag({ imageId, ...data }: { imageId: number; prompt?: string }) {
  const promptNsfw = hasNsfwWords(data.prompt);
  if (!promptNsfw) return;

  await dbWrite.$executeRaw`
    INSERT INTO "ImageFlag" ("imageId", "promptNsfw")
    VALUES (${imageId}, ${promptNsfw})
    ON CONFLICT ("imageId") DO UPDATE SET "promptNsfw" = EXCLUDED."promptNsfw";
  `;
}
