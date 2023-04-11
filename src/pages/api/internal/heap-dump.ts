import { writeHeapSnapshot } from "node:v8";
import { NextApiRequest, NextApiResponse } from "next";
import { JobEndpoint } from "~/server/utils/endpoint-helpers";
import { createReadStream } from "node:fs";

export default JobEndpoint (
  async function getHeapDump(req: NextApiRequest, res: NextApiResponse) {
    const path = writeHeapSnapshot();
    
    var readStream = createReadStream(path);
    res.send(readStream);
  }
)