import {
  getModelEarlyAccessRefundRequirement,
  getModelVersionEarlyAccessRefundRequirement,
  toEarlyAccessRefundSummary,
  type EarlyAccessRefundSummary,
} from '~/server/services/model-early-access-refund.service';
import {
  resolveUnpublishScope,
  type UnpublishScope,
} from '~/server/services/model-version.service';

/**
 * What unpublishing this version will actually do, priced at the scope it will run at.
 *
 * Taking down the last live version takes the model with it, and the model-scoped requirement
 * covers every version — including siblings already down that still hold refundable grants, which a
 * moderator take-down leaves in place. Pricing per-version there would show a creator one figure and
 * debit another; and where the version figure is zero and the model figure is not, the mutation
 * refuses with nothing in the UI able to consent. `scope` is what the dialog words itself from.
 *
 * Lives outside the router so it can be tested without the router's import graph — the branch here
 * is the one the whole cascade design rests on.
 */
export const getUnpublishImpact = async (
  id: number
): Promise<EarlyAccessRefundSummary & { scope: UnpublishScope }> => {
  const scope = await resolveUnpublishScope(id);
  const requirement =
    scope.kind === 'model'
      ? await getModelEarlyAccessRefundRequirement({ id: scope.modelId })
      : await getModelVersionEarlyAccessRefundRequirement({ id });

  return { ...toEarlyAccessRefundSummary(requirement), scope: scope.kind };
};
