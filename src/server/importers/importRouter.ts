import { hfModelImporter } from '~/server/importers/huggingFaceModel';
import { prisma } from '~/server/db/client';
import { ImportStatus } from '@prisma/client';
import { hfAuthorImporter } from '~/server/importers/huggingFaceAuthor';

const importers = [hfModelImporter, hfAuthorImporter];

export async function processImport({
  id,
  source,
  userId,
}: {
  id: number;
  source: string;
  userId?: number | null;
}) {
  const importer = importers.find((i) => i.canHandle(source));

  const updateStatus = async (status: ImportStatus, data?: any) => {
    await prisma.import.update({
      where: { id },
      data: { status, data },
    });
    return { id, status, data };
  };

  if (!importer) {
    return await updateStatus(ImportStatus.Failed, { error: 'No importer found' });
  }

  await updateStatus(ImportStatus.Processing);
  try {
    const { status, data, dependencies } = await importer.run(id, source, userId ?? 1);
    try {
      if (dependencies) for (const importJob of dependencies) await processImport(importJob);
    } catch (e) {} // We handle this inside the processImport...

    return await updateStatus(status, data);
  } catch (error: any) {
    console.error(error);
    return await updateStatus(ImportStatus.Failed, { error: error.message, stack: error.stack });
  }
}
