import { Prisma } from '@prisma/client';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

/**
 * What an automatic rating may not override, so its verdict is held as a moderator's lead instead: a
 * minor or POI model (the model form and the profanity check keep it SFW), a Private model (it must
 * stay SFW-only; the lead applies when it leaves Private), and a moderator's SFW-only lock.
 */
export const holdsRatingSql = Prisma.sql`(m.minor OR m.poi OR m.availability = 'Private'
  OR 'sfwOnly' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))`;

/** Where being Private is the one thing holding the rating, for a write that adds no lead otherwise. */
export const onlyPrivateHoldsRatingSql = Prisma.sql`(m.availability = 'Private'
  AND NOT (m.minor OR m.poi OR m."sfwOnly"))`;

/**
 * The `restrictedNsfwVerdict` a hold merges into `m.meta`. A lead already waiting keeps its time and
 * restriction; on a model no longer minor or POI it drops `liftedBy`, as a new verdict is no lifted
 * flag's.
 */
export function heldLeadSql(source: string) {
  return Prisma.sql`jsonb_build_object(
    'restrictedNsfwVerdict', COALESCE(
      CASE WHEN m.minor OR m.poi THEN m.meta->'restrictedNsfwVerdict'
        ELSE (m.meta->'restrictedNsfwVerdict') - 'liftedBy' END,
      jsonb_build_object(
        'source', ${source}::text,
        'at', now(),
        'restriction', CASE WHEN m.minor THEN 'minor' WHEN m.poi THEN 'poi' ELSE 'sfwOnly' END
      )
    )
  )`;
}

/**
 * Records the verdict as a moderator's lead, without touching nsfw, where the rating may not be
 * overridden (`holdsRatingSql`). Guarded on there being no nsfw lock: a moderator's lock is already a
 * ruling. A lead already waiting keeps its time and restriction, so a redelivery does not move it in
 * the queue and an owner who later unticks the flag does not relabel it. On a model no longer minor or
 * POI the new verdict is not a lifted flag's, so it applies as any held lead. True when it wrote.
 *
 * `privateOnly`: only where being Private is the one thing holding the rating. The profanity check
 * records just its detection on a minor, POI or SFW-only model, and that stays so.
 */
export async function holdRestrictedVerdict(
  db: { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number> },
  modelId: number,
  source: string,
  { privateOnly = false }: { privateOnly?: boolean } = {}
) {
  const held = await db.$executeRaw`
    UPDATE "Model" m
    SET meta = ${asJsonbObjectSql('m.meta')} || ${heldLeadSql(source)}
    WHERE m.id = ${modelId}
      AND ${holdsRatingSql}
      AND NOT ('nsfw' = ANY(COALESCE(m."lockedProperties", ARRAY[]::text[])))
      ${privateOnly ? Prisma.sql`AND ${onlyPrivateHoldsRatingSql}` : Prisma.empty}
  `;
  return held > 0;
}
