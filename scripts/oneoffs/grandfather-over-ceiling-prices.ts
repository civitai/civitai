/**
 * Grandfather prices that the removed tier caps were holding down.
 *
 * The revamp replaces per-tier price caps with one flat ceiling. Until now a stored price above the
 * owner's tier cap was silently clamped at charge time, so buyers paid the cap and the stored number
 * was aspirational. Deploying the revamp makes that stored number live — a price rise nobody asked
 * for, on versions people are already buying.
 *
 * This writes the price buyers were ACTUALLY being charged into the stored field, so the deploy
 * changes nothing for them. Creators keep charging exactly what they charged yesterday, and the rise
 * becomes opt-in: under the new rules any tier may raise up to the flat ceiling, whenever they choose.
 *
 * ⚠️ This LOWERS the stored number, and the old "re-subscribe and your original price comes back"
 * behaviour goes with it — there are no tier caps left to restore from. A creator who wants the
 * higher price sets it again.
 *
 * Usage:
 *   npm run tsscript scripts/oneoffs/grandfather-over-ceiling-prices.ts            # dry run (default)
 *   npm run tsscript scripts/oneoffs/grandfather-over-ceiling-prices.ts --apply
 *   npm run tsscript scripts/oneoffs/grandfather-over-ceiling-prices.ts --json
 *
 * 🔴 ORDERING: run this BEFORE the revamp deploys. Between the deploy and this script, buyers are
 * charged the un-clamped price. Running it after still stops the bleeding, but does not un-charge
 * anyone.
 *
 * Idempotent: it only ever lowers a price to a cap, so a second run finds nothing over cap and
 * writes nothing. Safe to resume after a partial failure by running it again.
 */
import { PrismaClient } from '@prisma/client';
import { capMediaType } from '@civitai/buzz';

// The cap tables as they stood before the revamp deleted them. Copied here deliberately: this script
// is their last consumer, and it has to keep computing what the OLD code charged even though nothing
// else does any more. Do not re-export these — they are history, not policy.
const VIDEO_CAP_MULTIPLIER = 5;
const BRONZE_FEE_CAP = { checkpoint: 3, default: 1 };
const LICENSING_FEE_CAP_BY_TIER: Record<string, { checkpoint: number; default: number }> = {
  free: { checkpoint: 1, default: 0.1 },
  founder: BRONZE_FEE_CAP,
  bronze: BRONZE_FEE_CAP,
  silver: { checkpoint: 10, default: 5 },
  gold: { checkpoint: 100, default: 100 },
};
const PAID_ACCESS_PRICE_CAP_BY_TIER: Record<string, number> = {
  free: 500,
  founder: 1000,
  bronze: 1000,
  silver: 5000,
  gold: Infinity,
};

// An unknown or lapsed tier got the FREE cap, which is what made a lapse tighten the ceiling without
// a migration. Preserved exactly, or a lapsed creator is grandfathered at a cap they did not have.
const oldFeeCap = (tier: string | null, modelType: string | null, baseModel: string | null) => {
  const caps =
    (tier ? LICENSING_FEE_CAP_BY_TIER[tier] : undefined) ?? LICENSING_FEE_CAP_BY_TIER.free;
  const base = modelType === 'Checkpoint' ? caps.checkpoint : caps.default;
  return base * (capMediaType(baseModel) === 'video' ? VIDEO_CAP_MULTIPLIER : 1);
};

const oldAccessCap = (tier: string | null, baseModel: string | null) => {
  const base =
    (tier ? PAID_ACCESS_PRICE_CAP_BY_TIER[tier] : undefined) ?? PAID_ACCESS_PRICE_CAP_BY_TIER.free;
  return base * (capMediaType(baseModel) === 'video' ? VIDEO_CAP_MULTIPLIER : 1);
};

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const asJson = args.includes('--json');

const prisma = new PrismaClient();

// The owner's tier as the charge path resolves it: highest non-bad-state subscription, or null.
// Mirrors getCapTier — a bad-state sub charges as no sub, which is what the cap did too.
const TIER_SQL = `
  LEFT JOIN LATERAL (
    SELECT p.metadata->>'tier' AS tier
    FROM "CustomerSubscription" cs
    JOIN "Product" p ON p.id = cs."productId"
    WHERE cs."userId" = m."userId"
      AND cs.status NOT IN ('canceled','incomplete','incomplete_expired','past_due','unpaid')
    ORDER BY CASE p.metadata->>'tier'
      WHEN 'gold' THEN 4 WHEN 'silver' THEN 3 WHEN 'bronze' THEN 2 WHEN 'founder' THEN 2 ELSE 1 END DESC
    LIMIT 1
  ) t ON TRUE`;

type FeeRow = {
  id: number;
  licensingFee: string;
  modelType: string | null;
  baseModel: string | null;
  tier: string | null;
};
type GateRow = { entityId: number; terms: unknown; baseModel: string | null; tier: string | null };

async function main() {
  const feeRows = await prisma.$queryRawUnsafe<FeeRow[]>(`
    SELECT mv.id, mv."licensingFee"::text AS "licensingFee", m.type::text AS "modelType",
           mv."baseModel", t.tier
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    ${TIER_SQL}
    WHERE mv."licensingFee" IS NOT NULL AND mv."licensingFee" > 0
      AND mv.status = 'Published'::"ModelStatus"
      AND m."deletedAt" IS NULL`);

  const feeClamps = feeRows
    .map((r) => ({
      ...r,
      stored: Number(r.licensingFee),
      cap: oldFeeCap(r.tier, r.modelType, r.baseModel),
    }))
    .filter((r) => r.stored > r.cap);

  const gateRows = await prisma.$queryRawUnsafe<GateRow[]>(`
    SELECT pa."entityId", pa.terms, mv."baseModel", t.tier
    FROM "PaidAccess" pa
    JOIN "ModelVersion" mv ON mv.id = pa."entityId"
    JOIN "Model" m ON m.id = mv."modelId"
    ${TIER_SQL}
    WHERE pa."entityType" = 'ModelVersion' AND pa."timeframeDays" IS NULL
      AND m."deletedAt" IS NULL`);

  // Both chargeable tiers are clamped independently — the gate's own shape decides which exist, and a
  // gate carrying only a generation price must not be judged by a download price it does not have.
  const gateClamps = gateRows
    .map((r) => {
      const cap = oldAccessCap(r.tier, r.baseModel);
      const terms = (r.terms ?? {}) as Record<string, { price?: number } | undefined>;
      const next: Record<string, { price?: number } | undefined> = { ...terms };
      let changed = false;
      for (const kind of ['download', 'generation'] as const) {
        const price = terms[kind]?.price;
        if (typeof price === 'number' && price > cap) {
          next[kind] = { ...terms[kind], price: cap };
          changed = true;
        }
      }
      return { entityId: r.entityId, tier: r.tier, cap, terms, next, changed };
    })
    .filter((r) => r.changed);

  const summary = {
    fees: {
      affected: feeClamps.length,
      owners: new Set(feeClamps.map((r) => r.id)).size,
      maxMultiple: feeClamps.reduce((m, r) => Math.max(m, r.stored / r.cap), 0),
    },
    gates: { affected: gateClamps.length },
    apply,
  };

  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else
    console.log(
      `[grandfather] apply=${apply} fees=${summary.fees.affected} gates=${summary.gates.affected} ` +
        `maxFeeMultiple=${summary.fees.maxMultiple.toFixed(1)}x`
    );

  if (!apply) {
    await prisma.$disconnect();
    return;
  }

  // One statement per row rather than a bulk CASE: the set is small, and a partial failure then leaves
  // every row it did reach already at its cap, which a re-run simply skips.
  for (const row of feeClamps) {
    await prisma.modelVersion.update({ where: { id: row.id }, data: { licensingFee: row.cap } });
  }
  for (const row of gateClamps) {
    await prisma.paidAccess.update({
      where: { entityType_entityId: { entityType: 'ModelVersion', entityId: row.entityId } },
      data: { terms: row.next as never },
    });
  }

  console.log(`[grandfather] wrote ${feeClamps.length} fees, ${gateClamps.length} gates`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
