/**
 * The `tips` body sent to the orchestrator. With no tip-eligible resource the creator tip is dropped
 * rather than charged, since the orchestrator would have no one to pay it to.
 */
export function buildWorkflowTips({
  civitaiTip,
  creatorTip,
  hasTipEligibleResource,
}: {
  civitaiTip?: number;
  creatorTip?: number;
  hasTipEligibleResource: boolean;
}) {
  const creators = hasTipEligibleResource ? creatorTip ?? 0 : 0;
  const civitai = civitaiTip ?? 0;
  return civitai || creators ? { civitai, creators } : undefined;
}
