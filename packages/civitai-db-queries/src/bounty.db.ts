import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// BountyEntry: only entries with NO benefactors (Prisma `benefactors: { none: {} }`). The relation is
// `BountyBenefactor.awardedToId -> BountyEntry.id`.
export function deleteBountyEntryForUser(db: Kysely<DB>, userId: number) {
  return db
    .deleteFrom('BountyEntry')
    .where('userId', '=', userId)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('BountyBenefactor')
            .select(sql`1`.as('one'))
            .whereRef('BountyBenefactor.awardedToId', '=', 'BountyEntry.id')
        )
      )
    )
    .execute();
}
export function deleteBountyForUser(db: Kysely<DB>, userId: number) {
  return db.deleteFrom('Bounty').where('userId', '=', userId).execute();
}
