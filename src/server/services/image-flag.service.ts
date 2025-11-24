import { dbWrite } from '~/server/db/client';
import { ImageFlags } from '~/server/common/enums';
import { hasNsfwPrompt } from '~/utils/metadata/audit';

export async function upsertImageFlag({ imageId, ...data }: { imageId: number; prompt?: string }) {
  const promptNsfw = hasNsfwPrompt(data.prompt);
  const operation = promptNsfw ? '|' : '& ~';
  await dbWrite.$executeRawUnsafe(`
    UPDATE "Image"
    SET flags = flags ${operation} ${ImageFlags.promptNsfw}
    WHERE id = ${imageId};
  `);
}
