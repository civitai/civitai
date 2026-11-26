// Example of a restricted endpoint that only authenticated users can access.

import type { NextApiRequest, NextApiResponse } from 'next';
import { getApiAuthSession } from '~/server/auth/api-auth-session';

const restricted = async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await getApiAuthSession({ req, res }, { whenBanned: 'anonymous' });

  if (session) {
    res.send({
      content: 'This is protected content. You can access this content because you are signed in.',
    });
  } else {
    res.send({
      error: 'You must be signed in to view the protected content on this page.',
    });
  }
};

export default restricted;
