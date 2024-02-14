import { dbRead } from '~/server/db/client';
import {
  BuildCapability,
  BuildComponent,
  GetBuildGuideByBudgetSchema,
} from '~/server/schema/build-guide.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';

export async function getBuildGuideByBudget({ budget, processor }: GetBuildGuideByBudgetSchema) {
  const result = await dbRead.buildGuide.findFirst({
    where: { name: { equals: `${budget}_${processor}`, mode: 'insensitive' } },
    select: {
      id: true,
      name: true,
      message: true,
      components: true,
      capabilities: true,
      updatedAt: true,
      user: { select: simpleUserSelect },
    },
  });
  if (!result) return null;

  return {
    ...result,
    components: result.components as BuildComponent[],
    capabilities: result.capabilities as BuildCapability,
  };
}
