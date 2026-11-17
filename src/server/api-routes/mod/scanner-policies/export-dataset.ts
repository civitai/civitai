import type { NextApiRequest, NextApiResponse } from 'next';
import { exportDatasetInputSchema } from '~/server/schema/scanner-policies.schema';
import { buildDatasetExport } from '~/server/services/scanner-policies-dataset.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { getGetUrlByKey } from '~/utils/s3-utils';

/**
 * POST /api/mod/scanner-policies/export-dataset
 *
 * Body: { mode, label, max }
 * Response: { exportId, filename, rowCount, perBucket, downloadUrl }
 *
 * Builds the input workbook for a (mode, label) dataset, uploads it to S3,
 * records the export in sysRedis, and returns a fresh signed download URL.
 * tRPC was the alternative but the body shape is simple enough and this
 * keeps the binary path consistent with the run-tests + result endpoints.
 */
export default ModEndpoint(
  async (req: NextApiRequest, res: NextApiResponse, user) => {
    const parsed = exportDatasetInputSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
    }

    try {
      const exportResult = await buildDatasetExport(parsed.data, user.id);
      const { url } = await getGetUrlByKey(exportResult.s3Key, { fileName: exportResult.filename });
      return res.status(200).json({
        exportId: exportResult.exportId,
        filename: exportResult.filename,
        rowCount: exportResult.rowCount,
        perBucket: exportResult.perBucket,
        downloadUrl: url,
      });
    } catch (err) {
      const e = err as Error;
      return res.status(500).json({ error: e.message, stack: e.stack });
    }
  },
  ['POST']
);
