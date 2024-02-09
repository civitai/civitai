import { GetBuildGuideByBudgetSchema } from '~/server/schema/build-guide.schema';
import { getBuildGuideByBudget } from '~/server/services/build-guide.services';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export async function getBuildGuideHandler({ input }: { input: GetBuildGuideByBudgetSchema }) {
  try {
    const buildGuide = await getBuildGuideByBudget(input);
    if (!buildGuide) throw throwNotFoundError('Build guide not found');

    return {
      ...buildGuide,
      totalPrice: buildGuide.components.reduce((acc, x) => acc + x.price, 0),
    };
  } catch (error) {
    throw throwDbError(error);
  }
}
