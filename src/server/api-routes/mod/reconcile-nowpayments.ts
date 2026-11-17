import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { reconcileDeposits } from '~/server/services/nowpayments.service';
import { logToAxiom } from '~/server/logging/client';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z
  .object({
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    paymentIds: commaDelimitedNumberArray().optional(), // comma-separated payment IDs
  })
  .refine((data) => (data.dateFrom && data.dateTo) || data.paymentIds, {
    message: 'Provide either dateFrom+dateTo or paymentIds',
  });

export default ModEndpoint(
  async (req: NextApiRequest, res: NextApiResponse) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({
        error:
          'Invalid parameters. Provide dateFrom+dateTo (e.g. 2026-03-01) or paymentIds (comma-separated)',
        details: parsed.error.flatten(),
      });
    }

    const { dateFrom, dateTo, paymentIds } = parsed.data;

    try {
      const results = await reconcileDeposits({
        dateFrom,
        dateTo,
        paymentIds,
      });

      logToAxiom({
        type: 'info',
        name: 'reconcile-nowpayments',
        message: `Reconciliation complete: ${results.newlyProcessed} processed, ${results.alreadyProcessed} already done, ${results.failed} failed`,
        dateFrom,
        dateTo,
        paymentIds,
        totalPayments: results.totalPayments,
        completedPayments: results.completedPayments,
        alreadyProcessed: results.alreadyProcessed,
        newlyProcessed: results.newlyProcessed,
        failed: results.failed,
        skipped: results.skipped,
      });

      return res.status(200).json(results);
    } catch (e) {
      const error = e as Error;
      logToAxiom({
        type: 'error',
        name: 'reconcile-nowpayments',
        message: error.message,
        stack: error.stack,
        dateFrom,
        dateTo,
        paymentIds,
      });
      return res.status(500).json({ error: error.message });
    }
  },
  ['GET']
);
