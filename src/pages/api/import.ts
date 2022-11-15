import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';
import { prisma } from '~/server/db/client';
import { z } from 'zod';
import { processImport } from '~/server/importers/importRouter';

const importSchema = z.object({
  source: z.string().url(),
});

export default async function importSource(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  const { id: userId, isModerator } = session?.user ?? {};
  if (!isModerator) return res.status(401).json({ error: 'Unauthorized' });
  const { source } = importSchema.parse(req.query);

  const result = await prisma.import.create({
    data: {
      source,
      userId,
    },
    select: {
      id: true,
      status: true,
    },
  });

  res.status(200).json(result);

  await processImport({ id: result.id, source });
}
