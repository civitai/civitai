import { dbWrite } from '~/server/db/client';
import { hasNsfwWords } from '~/utils/metadata/audit';

export async function upsertModelFlag({
  modelId,
  ...data
}: {
  modelId: number;
  name?: string;
  scanResult?: { poi: boolean; nsfw: boolean; minor: boolean; triggerWords: true };
}) {
  const nameNsfw = hasNsfwWords(data.name);
  if (!nameNsfw) return;

  await dbWrite.$executeRaw`
    INSERT INTO "ModelFlag" ("modelId", "nameNsfw")
    VALUES (${modelId}, ${nameNsfw})
    ON CONFLICT ("modelId") DO UPDATE SET "nameNsfw" = EXCLUDED."nameNsfw";
  `;
}
