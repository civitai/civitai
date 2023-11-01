import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { dbRead } from '~/server/db/client';
import { JobEndpoint } from '~/server/utils/endpoint-helpers';
import { getDownloadUrl } from '~/utils/delivery-worker';

const requestSchema = z.object({
  id: z.preprocess((x) => (x ? parseInt(String(x)) : undefined), z.number()),
});

export default JobEndpoint(async function getPresignedUrl(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { id: fileId } = requestSchema.parse(req.query);
  const file = await dbRead.modelFile.findFirst({
    select: { url: true },
    where: { id: fileId },
  });

  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  const result = await getDownloadUrl(file.url);
  return res.status(200).json(result);
});
