import { dbRead } from '~/server/db/client';
import { BuildCapability, BuildComponent } from '~/server/schema/build-guide.schema';
import { simpleUserSelect } from '~/server/selectors/user.selector';

export async function getBuildGuides() {
  const resultRaw = await dbRead.buildGuide.findMany({
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
  if (!resultRaw) return null;

  const results = resultRaw.map((result) => {
    const components = result.components as BuildComponent[];
    const capabilities = result.capabilities as BuildCapability;
    return {
      ...result,
      components,
      capabilities,
      totalPrice: components.reduce((acc, x) => acc + x.price, 0),
    };
  });

  return results;
}
