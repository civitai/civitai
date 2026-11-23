import { constants } from '~/server/common/constants';
import { createBuzzEvent } from '../base.reward';

const type = 'reportAccepted' as const;
export const reportAcceptedReward = createBuzzEvent({
  type,
  toAccountType: 'blue',
  description: 'For each report you make that is accepted',
  awardAmount: 50,
  caps: [{ amount: 1500, interval: 'month', keyParts: ['toUserId'] }],
  getKey: async (input: ReportEvent) => {
    // The system account files reports on Civitai's behalf; an accepted one earns nobody Buzz.
    if (input.userId === constants.system.user.id) return false;
    return {
      toUserId: input.userId,
      forId: input.reportId,
      byUserId: input.userId,
      type,
    };
  },
  // A report earns once, on its first acceptance. A later acceptance of the same report writes a
  // new pending row under the same key at a lower version than the one already settled; a payment
  // retry is reset to pending at a HIGHER version than its settled row, so it still pays.
  // A failed read throws, leaving the events pending for the job to retry.
  preprocess: async ({ ch, toProcess }) => {
    if (!toProcess.length) return;
    const rows = await ch
      .query({
        query: `
          SELECT toUserId, forId, max(version) AS version
          FROM buzzEvents
          WHERE type = {type:String}
            AND status != 'pending'
            AND (toUserId, forId) IN {keys:Array(Tuple(Int32, Int32))}
          GROUP BY toUserId, forId
        `,
        query_params: {
          type,
          keys: toProcess.map((event) => [Number(event.toUserId), Number(event.forId)]),
        },
        format: 'JSONEachRow',
      })
      .then((result) => result.json<{ toUserId: number; forId: number; version: number }>());

    const settled = new Map(
      rows.map((row) => [`${row.toUserId}:${row.forId}`, Number(row.version)])
    );
    for (const event of toProcess) {
      const settledVersion = settled.get(`${Number(event.toUserId)}:${Number(event.forId)}`);
      if (settledVersion === undefined || settledVersion < (event.version ?? 0)) continue;
      event.status = 'unqualified';
      event.awardAmount = 0;
      // The job writes this row back at version + 1. It shares the settled row's key, and buzzEvents
      // keeps the highest version per key, so it must land BELOW the settled row: at an equal version
      // the later insert replaces the original payment, which then drops out of the cap sum.
      event.version = Math.max(settledVersion - 2, -1);
    }
  },
});

type ReportEvent = {
  reportId: number;
  userId: number;
};
