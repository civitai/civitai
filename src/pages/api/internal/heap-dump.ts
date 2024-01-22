import { writeHeapSnapshot } from 'node:v8';
import { NextApiRequest, NextApiResponse } from 'next';
import { JobEndpoint } from '~/server/utils/endpoint-helpers';
import { createReadStream } from 'node:fs';

export default JobEndpoint(async function getHeapDump(req: NextApiRequest, res: NextApiResponse) {
  const localPath = `/tmp/heapdump-${Date.now()}.heapsnapshot`;
  if (global.gc) {
    global.gc();
  }
  writeHeapSnapshot(localPath);

  const readStream = createReadStream(localPath);
  res.send(readStream);
});
