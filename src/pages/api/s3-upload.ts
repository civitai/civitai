import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { UploadType } from '~/server/common/enums';
import { extname } from 'node:path';
import { filenamize, generateToken } from '~/utils/string-helpers';
import { getPutUrl } from '~/utils/s3-utils';

const upload = async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { filename: fullFilename } = req.body;
  const ext = extname(fullFilename);
  const filename = filenamize(fullFilename.replace(ext, ''));
  let { type } = req.body;
  if (!type || !Object.values(UploadType).includes(type)) type = UploadType.Default;

  const key = `${userId}/${type ?? UploadType.Default}/${filename}.${generateToken(4)}${ext}`;
  const result = await getPutUrl(key);

  res.status(200).json(result);
};

export default upload;
