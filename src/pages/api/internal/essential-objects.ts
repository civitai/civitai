import { NextApiRequest, NextApiResponse } from "next";
import { dbRead } from "~/server/db/client";
import { JobEndpoint } from "~/server/utils/endpoint-helpers";
import { parseKey } from "~/utils/s3-utils";

export default JobEndpoint (
  async function getEssentialObjects(req: NextApiRequest, res: NextApiResponse) {
    const modelFiles = await dbRead.modelFile.findMany({
      select: { url: true }
    });

    const objectKeys = new Set<string>();

    for (const { url } of modelFiles) {
      const { key } = parseKey(url);

      objectKeys.add(key);
    }

    return res.status(200).json(Array.from(objectKeys));
  }
)