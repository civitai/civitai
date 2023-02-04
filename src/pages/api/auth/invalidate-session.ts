import { invalidateSession } from '~/server/utils/session-helpers';
import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  if (session?.user) invalidateSession(session.user.id);
}
