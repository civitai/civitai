import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { Tracker } from '~/server/clickhouse/client';

const schema = z.object({
  activities: z.string().array(),
});

export default async function activity(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  const { activities } = schema.parse(req.body);
  const tracker = new Tracker(req, res);
  for (const activity of activities) await tracker.activity(activity);

  return res.status(200).json({ count: activities.length });
}
