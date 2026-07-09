import type { NextApiRequest, NextApiResponse } from 'next';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { uploadExternalCsamEvidence } from '~/server/services/csam.service-new';

// Streams a moderator-supplied evidence zip (for an external-link CSAM report)
// directly into the locked-down CSAM bucket. CSAM evidence must never touch the
// public image bucket / CDN, so this bypasses the normal upload pipeline.
//
// POST /api/mod/csam-upload?filename=<name>.zip   body: raw zip bytes
// -> { bucketKey, filename }
export const config = {
  api: {
    bodyParser: false,
  },
};

export default ModEndpoint(
  async (req: NextApiRequest, res: NextApiResponse, user) => {
    const filenameParam = Array.isArray(req.query.filename)
      ? req.query.filename[0]
      : req.query.filename;
    const filename = (filenameParam ?? 'evidence.zip').replace(/[^a-zA-Z0-9_.-]/g, '_');

    try {
      const result = await uploadExternalCsamEvidence({
        stream: req,
        moderatorId: user.id,
        filename,
      });
      return res.status(200).json(result);
    } catch (e) {
      const error = e as Error;
      return res.status(500).json({ error: error.message ?? 'Failed to upload evidence' });
    }
  },
  ['POST']
);
