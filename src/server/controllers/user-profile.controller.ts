import { Context } from '~/server/createContext';
import { throwDbError } from '~/server/utils/errorHandling';
import { GetByIdInput } from '~/server/schema/base.schema';
import { getUserById } from '~/server/services/user.service';
import { userWithCosmeticsSelect, userWithProfileSelect } from '~/server/selectors/user.selector';
import { imageSelect } from '~/server/selectors/image.selector';
import { ruleSet } from '@aws-sdk/client-s3/dist-types/endpoint/ruleset';

export const getUserProfileHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    const user = await getUserById({
      id: input.id,
      select: userWithProfileSelect,
    });
    return user;
  } catch (error) {
    throw throwDbError(error);
  }
};
