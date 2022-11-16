import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';
import { prisma } from '~/server/db/client';
import { z } from 'zod';
import { processImport } from '~/server/importers/importRouter';

const importSchema = z.object({
  source: z.string().url(),
  wait: z.boolean().optional().default(false),
});

export default async function importSource(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  const { id: userId, isModerator } = session?.user ?? {};
  if (!isModerator) return res.status(401).json({ error: 'Unauthorized' });
  const { source, wait } = importSchema.parse(req.query);

  const { id } = await prisma.import.create({
    data: {
      source,
      userId,
    },
    select: { id: true },
  });

  if (wait) {
    const result = await processImport({ id, source });
    res.status(200).json(result);
  } else {
    res.status(200).json({ id });
    await processImport({ id, source });
  }
}
