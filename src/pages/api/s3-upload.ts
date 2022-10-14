import { NextApiRequest, NextApiResponse } from 'next';
import { STSClient, GetSessionTokenCommand, STSClientConfig } from '@aws-sdk/client-sts';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';

const upload = async (req: NextApiRequest, res: NextApiResponse) => {
  const missing = missingEnvs();
  if (missing.length > 0) {
    res.status(500).json({ error: `Next S3 Upload: Missing ENVs ${missing.join(', ')}` });
    return;
  }

  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const config: STSClientConfig = {
    credentials: {
      accessKeyId: process.env.S3_UPLOAD_KEY as string,
      secretAccessKey: process.env.S3_UPLOAD_SECRET as string,
    },
    region: 'us-east-1',
    endpoint: 'https://sts.wasabisys.com',
  };

  const bucket = process.env.S3_UPLOAD_BUCKET;

  const { filename, type } = req.body;
  const key = `${userId}/${type ?? 'default'}/${filename}`;

  // TODO S3: Secure the bucket so that only the user can access their own files
  // const policy = {
  //   Statement: [
  //     {
  //       Sid: 'Stmt1S3UploadAssets',
  //       Effect: 'Allow',
  //       Action: ['s3:PutObject'],
  //       Resource: [`arn:aws:s3:::${bucket}/${key}`],
  //     },
  //   ],
  // };

  const sts = new STSClient(config);
  const command = new GetSessionTokenCommand({
    DurationSeconds: 60 * 60, // 1 hour
  });
  console.log('test3');

  const token = await sts.send(command);
  res.status(200).json({
    token,
    key,
    bucket,
    region: process.env.S3_UPLOAD_REGION,
    endpoint: process.env.S3_UPLOAD_ENDPOINT,
  });
};

export default upload;

// This code checks the for missing env vars that this
// API route needs.
//
// Why does this code look like this? See this issue!
// https://github.com/ryanto/next-s3-upload/issues/50
//
let missingEnvs = (): string[] => {
  const keys = [];
  if (!process.env.S3_UPLOAD_KEY) {
    keys.push('S3_UPLOAD_KEY');
  }
  if (!process.env.S3_UPLOAD_SECRET) {
    keys.push('S3_UPLOAD_SECRET');
  }
  if (!process.env.S3_UPLOAD_REGION) {
    keys.push('S3_UPLOAD_REGION');
  }
  if (!process.env.S3_UPLOAD_ENDPOINT) {
    keys.push('S3_UPLOAD_ENDPOINT');
  }
  if (!process.env.S3_UPLOAD_BUCKET) {
    keys.push('S3_UPLOAD_BUCKET');
  }
  return keys;
};
