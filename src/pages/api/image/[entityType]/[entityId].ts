import { NextApiRequest, NextApiResponse } from 'next';

export default function imageForEntity(req: NextApiRequest, res: NextApiResponse) {
  const { entityType, entityId } = req.query;
  // TODO.Manuel impement imageForEntity

  return res.redirect(
    302,
    'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/657ba2ea-cd05-4576-cc80-19f97655e400/original=true/image.png'
  );
}
