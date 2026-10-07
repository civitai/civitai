import { anyTipEligible } from '~/shared/utils/creator-tip';
import { isDefined } from '~/utils/type-guards';

export interface ResourceSnapshot {
  model?: { id: number };
  resources?: { id: number }[];
  vae?: { id: number };
}

/** Whether the creator tip applies to this selection: some selected resource can receive a share. */
export function hasTipEligibleSelection(
  snapshot: ResourceSnapshot,
  resourceData: { id: number; tipsEnabled?: boolean }[]
): boolean {
  const { model, resources, vae } = snapshot;
  const selectedIds = [model?.id, ...(resources ?? []).map((r) => r.id), vae?.id].filter(isDefined);
  return anyTipEligible(selectedIds.map((id) => resourceData.find((d) => d.id === id) ?? {}));
}
