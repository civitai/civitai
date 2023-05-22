import { hfModelImporter } from '~/server/importers/huggingFaceModel';
import { dbWrite } from '~/server/db/client';
import { ImportStatus, Prisma } from '@prisma/client';
import { hfAuthorImporter } from '~/server/importers/huggingFaceAuthor';
import { ImportDependency, ImportRunInput } from '~/server/importers/importer';
import { chunk } from 'lodash-es';

const importers = [hfModelImporter, hfAuthorImporter];

export async function processImport(input: ImportRunInput) {
  const { id, source } = input;
  const importer = importers.find((i) => i.canHandle(source));

  const updateStatus = async (status: ImportStatus, data: any = null) => { // eslint-disable-line
    await dbWrite.import.update({
      where: { id },
      data: { status, data: data ?? Prisma.JsonNull },
    });
    return { id, status, data };
  };

  if (!importer) {
    return await updateStatus(ImportStatus.Failed, { error: 'No importer found' });
  }

  await updateStatus(ImportStatus.Processing);
  try {
    const { status, data, dependencies } = await importer.run(input);
    if (dependencies) await processDependencies(input, dependencies);
    return await updateStatus(status, data);
  } catch (error: any) { // eslint-disable-line
    console.error(error);
    return await updateStatus(ImportStatus.Failed, { error: error.message, stack: error.stack });
  }
}

async function processDependencies(
  { userId, id: parentId }: ImportRunInput,
  deps: ImportDependency[]
) {
  // Add the import jobs
  for (const batch of chunk(deps, 900)) {
    await dbWrite.import.createMany({
      data: batch.map(({ source, data }) => ({
        source,
        userId,
        parentId,
        data,
      })),
    });
  }

  const childJobs = await dbWrite.import.findMany({
    where: {
      parentId,
    },
  });

  for (const batch of chunk(childJobs, 10)) {
    try {
      await Promise.all(batch.map((job) => processImport(job)));
    } catch (e) {} // We handle this inside the processImport...
  }
}
