import { NextApiRequest, NextApiResponse } from 'next';

export const JobEndpoint =
  (handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>) =>
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (req.query.token !== process.env.JOB_TOKEN) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await handler(req, res);
  };
