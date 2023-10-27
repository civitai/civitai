import { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { JobEndpoint } from '~/server/utils/endpoint-helpers';
import { parseKey } from '~/utils/s3-utils';

export default JobEndpoint(async function getEssentialObjects(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const objectKeys = new Set<string>();
  const addToKeys = (files: { url: string }[]) => {
    for (const { url } of files) {
      const { key } = parseKey(url);
      objectKeys.add(key);
    }
  };

  const modelFiles = await dbRead.modelFile.findMany({
    select: { url: true },
  });
  addToKeys(modelFiles);

  const files = await dbRead.file.findMany({
    select: { url: true },
  });
  addToKeys(files);

  return res.status(200).json(Array.from(objectKeys));
});
