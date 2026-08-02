import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { getPerceptualHash } from '~/server/services/orchestrator/orchestrator.service';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const schema = z.object({
  limit: z.coerce.number().min(1).max(5000).optional(),
  concurrency: z.coerce.number().min(1).max(20).optional(),
  cosmeticId: z.coerce.number().optional(),
  // Not z.coerce.boolean() — that's Boolean(value), so "false" would be true.
  // A bare `?dryRun` reads as intent to dry run; anything unrecognised is
  // rejected rather than guessed at.
  dryRun: z
    .enum(['true', 'false', '1', '0', ''])
    .transform((v) => v !== 'false' && v !== '0')
    .optional(),
  // Rows that can never be hashed (artwork 404s on the CDN) otherwise consume
  // the same head-of-queue slots on every run, stranding everything behind them.
  afterId: z.coerce.number().optional(),
});

type CosmeticRow = { id: number; url: string; animated: boolean };

// Each hash can block for the orchestrator wait, so a batch has to stay well
// inside the ingress timeout — a dropped connection loses the report and invites
// a re-run against rows still in flight.
const DEFAULT_LIMIT = 100;

export default ModEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const {
    limit = DEFAULT_LIMIT,
    concurrency = 5,
    cosmeticId,
    dryRun,
    afterId,
  } = schema.parse(req.query);
  const start = Date.now();

  // Type isn't a reliable filter — NamePlate and ContentDecoration are CSS-only,
  // but the presence of `data.url` is what actually decides whether there's art.
  //
  // The pHashUrl comparison re-sweeps cosmetics whose artwork was replaced by a
  // path that doesn't hash (creator-shop edits, product badges), where the row
  // holds a hash of the *previous* image — worse than holding none.
  const records = await dbRead.$queryRaw<CosmeticRow[]>`
    SELECT
      id,
      data->>'url' as url,
      COALESCE((data->>'animated')::boolean, false) as animated
    FROM "Cosmetic"
    WHERE (data->>'url') IS NOT NULL
      AND (data->>'url') <> ''
      AND ("pHash" IS NULL OR "pHashUrl" IS DISTINCT FROM data->>'url')
      ${cosmeticId ? Prisma.sql`AND id = ${cosmeticId}` : Prisma.empty}
      ${afterId ? Prisma.sql`AND id > ${afterId}` : Prisma.empty}
    ORDER BY id
    LIMIT ${limit}
  `;

  if (dryRun) {
    return res.status(200).json({
      dryRun: true,
      pending: records.length,
      animated: records.filter((x) => x.animated).length,
    });
  }

  let hashed = 0;
  const failures: Array<{ id: number; animated: boolean }> = [];

  await limitConcurrency(
    records.map((record) => async () => {
      // limitConcurrency rejects the whole run on the first throw, which would
      // discard the tally for every row already done.
      try {
        const pHash = await getPerceptualHash(record.url);
        // `0n` is a real hash (solid-colour artwork), not a miss.
        if (pHash === undefined) {
          failures.push({ id: record.id, animated: record.animated });
          return;
        }
        await dbWrite.cosmetic.update({
          where: { id: record.id },
          data: { pHash, pHashUrl: record.url },
        });
        hashed++;
      } catch {
        failures.push({ id: record.id, animated: record.animated });
      }
    }),
    concurrency
  );

  return res.status(200).json({
    considered: records.length,
    hashed,
    failed: failures.length,
    failedAnimated: failures.filter((x) => x.animated).length,
    failedIds: failures.slice(0, 50).map((x) => x.id),
    // Pass back as `afterId` to step past a block of unhashable rows.
    lastId: records.at(-1)?.id,
    duration: Date.now() - start,
  });
});
