import { chunk } from 'lodash-es';
import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { limitConcurrency, type Task } from '~/server/utils/concurrency-helpers';
import { getTransactionStatusByKey } from '~/server/services/coinbase.service';
import { logToAxiom } from '~/server/logging/client';
import { CryptoTransactionStatus } from '~/shared/utils/prisma/enums';

const log = (data: MixedObject) => {
  logToAxiom({ name: 'crypto-transaction-job', type: 'error', ...data }).catch(() => null);
};
export const cleanupWaitingRampUpTransactions = createJob(
  'cleanup-waiting-ramp-up-transactions',
  '*/10 * * * *',
  async () => {
    const [lastRun, setLastRun] = await getJobDate('cleanup-waiting-ramp-up-transactions');

    await dbWrite.$executeRaw`
       UPDATE "CryptoTransaction" t
        SET "status" = 'RampTimedOut'
        WHERE "status" = 'WaitingRampUp'
        AND "createdAt" < ${lastRun} - INTERVAL '10 minutes' 
    `;

    await setLastRun();
  }
);

export const processPendingTransactions = createJob(
  'process-pending-transactions',
  '*/2 * * * *',
  async () => {
    const [lastRun, setLastRun] = await getJobDate('process-pending-transactions');
    const transactions = await dbWrite.$queryRaw<{ key: string; userId: number }[]>`
      SELECT "key", "userId" FROM "CryptoTransaction"
      WHERE "status" IN ('RampInProgress', 'RampSuccess', 'WaitingForSweep', 'SweepFailed', 'RampFailed')
      AND "updatedAt" > ${lastRun}
    `;

    const tasks: Task[] = transactions.map((data) => async () => {
      try {
        const status = await getTransactionStatusByKey(data);
        if (
          [CryptoTransactionStatus.RampFailed, CryptoTransactionStatus.SweepFailed].some(
            (s) => s === status
          )
        ) {
          log({ message: 'Failed to process transaction', ...data, status });
          return;
        }
      } catch (error) {
        console.error(`Error processing transaction ${data.key} for user ${data.userId}:`, error);
        log({
          message: 'Error processing transaction',
          error: (error as Error).message,
          ...data,
        });
      }
    });

    await limitConcurrency(tasks, 3);

    await setLastRun();
  }
);
