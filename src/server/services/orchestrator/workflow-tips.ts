/** A tip rate as the orchestrator expects it: a fraction of the base price, 0 to 1. */
function toTipRate(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * The `tips` body sent to the orchestrator. With no tip-eligible resource (none with a payable
 * owner other than the generating user) the creator tip is dropped rather than charged.
 */
export function buildWorkflowTips({
  civitaiTip,
  creatorTip,
  hasTipEligibleResource,
}: {
  civitaiTip?: unknown;
  creatorTip?: unknown;
  hasTipEligibleResource: boolean;
}) {
  const creators = hasTipEligibleResource ? toTipRate(creatorTip) : 0;
  const civitai = toTipRate(civitaiTip);
  return civitai || creators ? { civitai, creators } : undefined;
}
