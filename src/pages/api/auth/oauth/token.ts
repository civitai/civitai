import { Request, Response } from '@node-oauth/oauth2-server';
import { oauth } from '~/server/oauth/server';
import { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { profilePictureCache } from '~/server/redis/caches';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

export default async function (req: NextApiRequest, res: NextApiResponse) {
  try {
    const {
      client,
      user: { id: userId },
      ...token
    } = await oauth.token(new Request(req), new Response(res));
    const user = await dbRead.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, image: true },
    });
    if (user) {
      const profilePicture = await profilePictureCache.fetch([user.id]);
      if (profilePicture[user.id]) {
        user.image = getEdgeUrl(profilePicture[user.id].url, { width: 450 });
      }
    }

    return res.status(200).json({ ...token, user });
  } catch (error) {
    const err = error as Error;
    return res.status(400).json({ error: err.message });
  }
}
