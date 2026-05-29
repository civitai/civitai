import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

// Per-pool weights are mod-tunable from this endpoint. The refine() guard
// rejects `NaN` / `±Infinity` at the API boundary so we never persist a
// value that would produce `NaN` targets in `computePoolTargets` once read
// back from Redis. Length is locked to the three Knight* / Acolyte* /
// Templar* slots.
const poolWeightsSchema = z
  .array(z.number().refine(Number.isFinite, { message: 'weight must be finite' }).min(0))
  .length(3);

const configSchema = z.object({
  perMinute: z.number().int().min(1).optional(),
  perHour: z.number().int().min(1).optional(),
  perDay: z.number().int().min(1).optional(),
  autoSmiteAbusers: z.boolean().optional(),
  abuseDetection: z
    .object({
      minTotalRatings: z.number().int().min(1).optional(),
      havingDominantPct: z.number().min(0).max(100).optional(),
      havingAvgPerMinute: z.number().min(0).optional(),
      smiteDominantPct: z.number().min(0).max(100).optional(),
      smiteMaxUniqueRatings: z.number().int().min(1).optional(),
    })
    .optional(),
  poolQuotas: z
    .object({
      [NewOrderRankType.Acolyte]: poolWeightsSchema.optional(),
      [NewOrderRankType.Knight]: poolWeightsSchema.optional(),
      [NewOrderRankType.Templar]: poolWeightsSchema.optional(),
    })
    .optional(),
});

export default ModEndpoint(
  async (req: NextApiRequest, res: NextApiResponse) => {
    const key = REDIS_SYS_KEYS.NEW_ORDER.CONFIG;

    if (req.method === 'GET') {
      const config = await sysRedis.packed.get(key);
      return res.status(200).json({ config: config ?? null });
    }

    // PUT — update config
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid config', details: parsed.error.format() });
    }

    // Merge with existing config so partial updates work. Nested objects
    // (`abuseDetection`, `poolQuotas`) get merged one level deep so a PUT
    // touching only `{ poolQuotas: { Knight: [...] } }` doesn't wipe out an
    // existing `Acolyte` entry. Top-level scalars still hard-overwrite.
    const existing = ((await sysRedis.packed.get(key)) ?? {}) as Record<string, unknown>;
    const data = parsed.data;
    const merged: Record<string, unknown> = { ...existing, ...data };

    const mergeNested = (k: 'abuseDetection' | 'poolQuotas') => {
      const incoming = data[k];
      if (incoming === undefined) return;
      const prev = (existing[k] ?? {}) as Record<string, unknown>;
      merged[k] = { ...prev, ...(incoming as Record<string, unknown>) };
    };
    mergeNested('abuseDetection');
    mergeNested('poolQuotas');

    await sysRedis.packed.set(key, merged);

    return res.status(200).json({ config: merged });
  },
  ['GET', 'PUT']
);
