import { huggingFaceImporter } from '~/server/importers/huggingFace';
import { prisma } from '~/server/db/client';
import { ImportStatus } from '@prisma/client';

const importers = [huggingFaceImporter];

export async function processImport({ id, source }: { id: number; source: string }) {
  const importer = importers.find((i) => i.canHandle(source));

  const updateStatus = async (status: ImportStatus, data?: any) => {
    await prisma.import.update({
      where: { id },
      data: { status, data },
    });
  };

  if (!importer) {
    await updateStatus(ImportStatus.Failed, { error: 'No importer found' });
    return false;
  }

  await updateStatus(ImportStatus.Processing);
  try {
    const { status, data } = await importer.run(id, source);
    await updateStatus(status, data);
  } catch (error) {
    await updateStatus(ImportStatus.Failed, { error });
    return false;
  }

  return true;
}
