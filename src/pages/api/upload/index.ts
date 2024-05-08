import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import { UploadType } from '~/server/common/enums';
import { extname } from 'node:path';
import { filenamize, generateToken } from '~/utils/string-helpers';
import { getMultipartPutUrl } from '~/utils/s3-utils';
import { logToDb } from '~/utils/logging';
import { env } from '~/env/server.mjs';

const upload = async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId || session.user?.bannedAt) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { filename: fullFilename } = req.body;
  const ext = extname(fullFilename);
  const filename = filenamize(fullFilename.replace(ext, ''));
  let { type } = req.body;
  if (!type || !Object.values(UploadType).includes(type)) type = UploadType.Default;

  if (env.UPLOAD_PROHIBITED_EXTENSIONS?.includes(ext)) {
    return res.status(400).json({ error: 'File type not allowed' });
  }

  const key = `${type ?? UploadType.Default}/${userId}/${filename}.${generateToken(4)}${ext}`;
  const result = await getMultipartPutUrl(key, req.body.size);
  await logToDb('s3-upload', {
    userId,
    type,
    filename: fullFilename,
    key,
    uploadId: result.uploadId,
    bucket: result.bucket,
  });

  res.status(200).json(result);
};

export default upload;
